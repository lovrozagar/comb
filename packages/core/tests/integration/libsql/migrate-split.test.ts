/**
 * SL2 of r22, as a user runs it: a reviewed trigger whose body names a `begin` column, then the
 * statements after it. On 0.20.1 the splitter folded those into the trigger's statement, libsql ran
 * the trigger alone, and apply printed Done with the file recorded and its ALTER, index and backfill
 * never run.
 */
import { describe, expect, it } from "vitest"
import { migrateCli, migrateProject, sqliteRows } from "../support/migrate-project.ts"

const FILES = {
	"0001_ev.sql":
		"CREATE TABLE ev (id INTEGER PRIMARY KEY, begin INTEGER, finish INTEGER);\nCREATE TABLE audit (at INTEGER);\nINSERT INTO ev (begin) VALUES (1);\n",
	"0002_audit.sql":
		"-- comb:allow-unsafe: audit every new event\nCREATE TRIGGER ev_audit AFTER INSERT ON ev BEGIN\n  INSERT INTO audit (at) VALUES (new.begin);\nEND;\nALTER TABLE ev ADD COLUMN label TEXT;\nCREATE INDEX ev_label ON ev (label);\nUPDATE ev SET finish = begin + 1 WHERE finish IS NULL;\n",
}

describe("a SQLite file splits where SQLite ends a statement (SL2; sibling: libsql's skipped tail)", () => {
	it("applies every statement after a trigger whose body names begin, on a libsql file", async () => {
		const project = migrateProject(FILES)
		try {
			const run = await migrateCli(project.dir, ["migrate", "apply", "core", "--yes"])
			expect(run.code, run.errors.join("\n")).toBe(0)
			expect(await sqliteRows(project.url, "SELECT name FROM pragma_table_info('ev') ORDER BY cid")).toEqual([
				["id"],
				["begin"],
				["finish"],
				["label"],
			])
			expect(
				await sqliteRows(
					project.url,
					"SELECT type, name FROM sqlite_master WHERE tbl_name = 'ev' AND type != 'table' ORDER BY name",
				),
			).toEqual([
				["trigger", "ev_audit"],
				["index", "ev_label"],
			])
			expect(await sqliteRows(project.url, "SELECT begin, finish FROM ev")).toEqual([[1, 2]])
		} finally {
			project.dispose()
		}
	}, 60_000)
})
