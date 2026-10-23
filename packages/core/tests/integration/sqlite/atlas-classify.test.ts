/**
 * The destructive-change gate on what Atlas really emits for SQLite, where a column change
 * rebuilds the table: copy into `new_t`, drop `t`, rename. The rebuild is lossless only when it
 * copies every column the earlier migrations gave the table, so each case classifies Atlas's
 * output against the schema the base file leaves.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { classifyMigration, extractDropStatements } from "../../../src/migrate/core/classify.ts"
import { extractSchema } from "../../../src/migrate/core/parse.ts"
import type { MigrationSafety } from "../../../src/migrate/types.ts"
import { requireAtlas } from "../support/atlas.ts"

/* a run without Atlas would pass with its suites skipped, and a verify stamp would vouch for it:
   a missing binary fails the run, locally as in CI */
describe("atlas harness: configuration", () => {
	it("passes when atlas runs and refuses a missing binary, locally as in CI", () => {
		expect(() => requireAtlas(() => true)).not.toThrow()
		expect(() => requireAtlas(() => false)).toThrow("atlas is not on PATH: the Atlas suites are required")
	})
})

const BASE = `CREATE TABLE post (id text PRIMARY KEY, title text NOT NULL, body text, n integer);
CREATE TABLE gone (id text);
CREATE INDEX idx_post_title ON post (title);`

type Case = { drops: string[]; name: string; safety: MigrationSafety; to: string }

const CASES: readonly Case[] = [
	{
		drops: ["DROP COLUMN post.body"],
		name: "drop a column (a rebuild)",
		safety: "unsafe",
		to: BASE.replace(" body text,", ""),
	},
	{
		drops: ["DROP COLUMN post.body"],
		name: "rename a column (a rebuild)",
		safety: "unsafe",
		to: BASE.replace(" body text,", " content text,"),
	},
	/* INTEGER to TEXT affinity: a stored 7 lands as '7' (M5) */
	{ drops: [], name: "retype a column (a rebuild)", safety: "unsafe", to: BASE.replace("n integer", "n text") },
	{
		drops: [],
		name: "drop NOT NULL (a rebuild)",
		safety: "cautious",
		to: BASE.replace("title text NOT NULL", "title text"),
	},
	{
		drops: ["DROP TABLE gone"],
		name: "drop a table",
		safety: "unsafe",
		to: BASE.replace("CREATE TABLE gone (id text);\n", ""),
	},
	{
		drops: ["DROP INDEX idx_post_title"],
		name: "drop an index",
		safety: "cautious",
		to: BASE.replace("\nCREATE INDEX idx_post_title ON post (title);", ""),
	},
	{ drops: [], name: "add a nullable column", safety: "safe", to: BASE.replace("n integer", "n integer, extra text") },
]

describe("the destructive-change gate on Atlas's SQLite output", () => {
	let dir: string

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "comb-atlas-classify-"))
		writeFileSync(join(dir, "base.sql"), BASE)
	})
	afterAll(() => rmSync(dir, { force: true, recursive: true }))

	it.each(CASES)("classifies $name as Atlas emits it", ({ drops, safety, to }) => {
		writeFileSync(join(dir, "to.sql"), to)
		const args = [
			"schema",
			"diff",
			"--from",
			`file://${join(dir, "base.sql")}`,
			"--to",
			`file://${join(dir, "to.sql")}`,
		]
		const run = spawnSync("atlas", [...args, "--dev-url", "sqlite://dev?mode=memory"], { encoding: "utf8" })
		expect(run.stderr).toBe("")
		const options = { before: extractSchema(BASE), dialect: "sqlite" } as const
		expect(classifyMigration(run.stdout, options).safety, run.stdout).toBe(safety)
		expect(extractDropStatements(run.stdout, options)).toEqual(drops)
	})
})

describe("the Atlas SQLite cases", () => {
	it("change the base schema in every case", () => {
		expect(CASES.filter(({ to }) => to === BASE)).toEqual([])
	})
})
