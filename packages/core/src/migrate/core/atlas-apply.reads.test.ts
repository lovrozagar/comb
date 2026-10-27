/**
 * How often an apply reads each Postgres file with Postgres's parser: once (M86). pgRead is the
 * parse, so it is counted by wrapping pg-split's own.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyWithAtlas } from "./atlas-apply.ts"
import { sqlFiles } from "./atlas-dir.ts"
import { pgRead } from "./pg-split.ts"
import type { Run, RunResult } from "./process.ts"

vi.mock("./pg-split.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("./pg-split.ts")>()
	return { ...real, pgRead: vi.fn(real.pgRead) }
})

const FILES = { "1_a.sql": 'CREATE TABLE "a" ("id" int);\n', "2_b.sql": 'ALTER TABLE "a" ADD COLUMN "b" int;\n' }
const ok = (stdout = "{}"): RunResult => ({ code: 0, stderr: "", stdout })
const file = (name: string) => ({ Description: name.split("_")[1], Name: name, Version: name.split("_")[0] })

/** Atlas on a database with no history: hash writes a sum, status lists every file pending */
const atlas: Run = (_cmd, args) => {
	if (args[1] === "hash") {
		const dir = (args[args.indexOf("--dir") + 1] as string).replace("file://", "")
		writeFileSync(
			join(dir, "atlas.sum"),
			`h1:x=\n${sqlFiles(dir)
				.map((f) => `${f} h1:${f.length}=`)
				.join("\n")}\n`,
		)
		return ok()
	}
	if (args[1] !== "status") return ok()
	const files = Object.keys(FILES).map(file)
	return ok(
		JSON.stringify({ applied: [], available: files, current: "", error: "", pending: files, status: "PENDING" }),
	)
}

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-atlas-reads-"))
	for (const [name, sql] of Object.entries(FILES)) writeFileSync(join(dir, name), sql)
	writeFileSync(join(dir, "atlas.sum"), "h1:x=\n1_a.sql h1:7=\n2_b.sql h1:7=\n")
	vi.mocked(pgRead).mockClear()
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

describe("applyWithAtlas: each pending file read once (M86)", () => {
	it("parses each file once, for the schema it leaves, its approval, drops and classification", async () => {
		const approved: string[][] = []
		const target = { devUrl: "postgres://localhost/dev", lockTimeout: "5s", schema: "public", url: "postgres://db/app" }
		await applyWithAtlas({
			approve: async (migration) => (approved.push(migration.statements), { ok: true }),
			checkOnly: true,
			dir,
			exec: atlas,
			print: () => {},
			target,
		})
		const files = vi
			.mocked(pgRead)
			.mock.calls.map(([sql]) => sql)
			.filter((sql) => sql !== "")
		expect(files).toEqual(Object.values(FILES))
		expect(approved).toEqual([['CREATE TABLE "a" ("id" int)'], ['ALTER TABLE "a" ADD COLUMN "b" int']])
	})
})
