/**
 * The destructive-change gate on what Atlas really emits for Postgres. Each case diffs a base
 * schema against a changed one with the real binary on a scratch database, in both URL scopes
 * comb may use (database-scoped names are schema-qualified, `search_path` ones are bare), and
 * classifies the output, so the rules cannot drift from Atlas's SQL.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import type { MigrationSafety } from "../../../src/migrate/types.ts"
import { describeAtlas } from "../support/atlas.ts"
import { describePg, withScratchDb } from "../support/pg.ts"

const POST = (columns: string) => `CREATE TABLE post (id integer PRIMARY KEY, ${columns});`
const BASE = `${POST("title text NOT NULL, body text, big bigint, price numeric(10,2), n integer DEFAULT 1 CONSTRAINT post_n_check CHECK (n > 0)")}
CREATE TABLE gone (id integer);
CREATE INDEX idx_post_title ON post (title);`
const WITHOUT_GONE = BASE.replace("CREATE TABLE gone (id integer);\n", "")

const CASES: ReadonlyArray<[string, string, MigrationSafety]> = [
	["drop a table", WITHOUT_GONE, "unsafe"],
	["drop a column", BASE.replace(" body text,", ""), "unsafe"],
	["rename a column", BASE.replace(" body text,", " content text,"), "unsafe"],
	["narrow bigint to integer", BASE.replace("big bigint", "big integer"), "unsafe"],
	["narrow a numeric", BASE.replace("numeric(10,2)", "numeric(6,1)"), "unsafe"],
	["set NOT NULL", BASE.replace("body text,", "body text NOT NULL,"), "unsafe"],
	["add NOT NULL without a default", BASE.replace("body text,", "body text, req text NOT NULL,"), "unsafe"],
	["drop NOT NULL", BASE.replace("title text NOT NULL", "title text"), "safe"],
	["drop a default", BASE.replace(" DEFAULT 1", ""), "cautious"],
	["drop a check", BASE.replace(" CONSTRAINT post_n_check CHECK (n > 0)", ""), "cautious"],
	["drop an index", BASE.replace("\nCREATE INDEX idx_post_title ON post (title);", ""), "cautious"],
	["add a nullable column", BASE.replace("body text,", "body text, extra text,"), "safe"],
]

describePg("the destructive-change gate on Atlas's Postgres output", () => {
	describeAtlas("Atlas v1.3.0 diffs", () => {
		let dir: string

		beforeAll(() => {
			dir = mkdtempSync(join(tmpdir(), "comb-atlas-classify-"))
			writeFileSync(join(dir, "base.sql"), BASE)
		})
		afterAll(() => rmSync(dir, { force: true, recursive: true }))

		/** Atlas's SQL from the base schema to `to`, with the dev database in `scope` */
		const diff = (to: string, dev: string) => {
			writeFileSync(join(dir, "to.sql"), to)
			const from = `file://${join(dir, "base.sql")}`
			const args = ["schema", "diff", "--from", from, "--to", `file://${join(dir, "to.sql")}`, "--dev-url", dev]
			const run = spawnSync("atlas", args, { encoding: "utf8" })
			/* an empty diff with an empty stderr once showed here; its exit says whether Atlas finished */
			expect({ signal: run.signal, status: run.status, stderr: run.stderr }).toEqual({
				signal: null,
				status: 0,
				stderr: "",
			})
			return run.stdout
		}

		it.each(CASES)(
			"classifies %s as Atlas emits it, in both scopes",
			async (_, to, safety) => {
				await withScratchDb((url) => {
					const schemaScoped = new URL(url)
					schemaScoped.searchParams.set("search_path", "public")
					for (const dev of [url, schemaScoped.href]) {
						const sql = diff(to, dev)
						expect(sql).not.toBe("")
						expect(classifyMigration(sql, { dialect: "postgres" }).safety, sql).toBe(safety)
					}
				})
			},
			60_000,
		)
	})
})

describe("the Atlas Postgres cases", () => {
	it("change the base schema in every case", () => {
		expect(CASES.filter(([, to]) => to === BASE)).toEqual([])
	})
})
