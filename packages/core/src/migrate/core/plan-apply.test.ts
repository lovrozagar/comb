import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "./approval.ts"
import { planApply, type PlanOptions, wranglerOrder } from "./plan-apply.ts"

describe("wranglerOrder", () => {
	it("orders by leading number, then by name, files without a number last", () => {
		expect(wranglerOrder(["20250101000000_b.sql", "notes.sql", "20261020_a.sql", "9_z.sql", "9_y.sql"])).toEqual([
			"9_y.sql",
			"9_z.sql",
			"20261020_a.sql",
			"20250101000000_b.sql",
			"notes.sql",
		])
		expect(wranglerOrder(["b.sql", "a.sql", "a.sql"])).toEqual(["a.sql", "a.sql", "b.sql"])
	})
})

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-plan-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A plan over `files` in `dir`, nothing applied and no sum checked unless asked */
function plan(files: Record<string, string>, more: Partial<PlanOptions> = {}) {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	const out: string[] = []
	return {
		out,
		run: () =>
			planApply({
				applied: () => false,
				approve: (migration) => approveMigration(migration, { target: "core", yes: true }),
				dir,
				exec: () => ({ code: 0, stderr: "", stdout: "" }),
				files: Object.keys(files),
				print: (line) => out.push(line),
				whole: false,
				...more,
			}),
	}
}

describe("planApply", () => {
	it("classifies each pending file against the files before it, an applied one included, and says who approved it", async () => {
		const run = plan(
			{
				"1_a.sql": "CREATE TABLE t (id TEXT, a TEXT);",
				"2_b.sql":
					"-- comb:allow-unsafe: a is retired\nCREATE TABLE new_t (id TEXT);\nINSERT INTO new_t (id) SELECT id FROM t;\nDROP TABLE t;\nALTER TABLE new_t RENAME TO t;",
			},
			{ applied: (name) => name === "1_a.sql" },
		)
		const pending = await run.run()
		expect(pending.map(({ migration, name }) => [name, migration.classification.safety])).toEqual([
			["2_b.sql", "unsafe"],
		])
		expect(pending[0]?.before.tables.get("t")).toEqual(["id", "a"])
		expect(run.out).toEqual(["Approved in 2_b.sql: a is retired"])
	})

	it("stops at the first file it may not run", async () => {
		await expect(plan({ "1_drop.sql": "DROP TABLE t;" }).run()).rejects.toThrow(/^1_drop\.sql is unsafe/)
	})
})
