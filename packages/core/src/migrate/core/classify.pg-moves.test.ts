/**
 * PA17 of r22b: Postgres 17 rewrites nothing for a move to where a relation already is. A SET LOGGED
 * of a logged table, a SET UNLOGGED of an unlogged one, a SET ACCESS METHOD to its access method and
 * a SET TABLESPACE to its tablespace each return before the rewrite (ATPrepChangePersistence,
 * ATPrepSetAccessMethod, CheckRelationTableSpaceMove), taking 0 ms with no relfilenode change in
 * .tmp/grunt/r22b/migrate-pg-atlas/lock/matrix.log. comb reads where a relation is from the history,
 * as PA11 reads a retype: its persistence always, and its access method or tablespace only where the
 * history names it, since one made without USING or TABLESPACE takes the target's
 * default_table_access_method and default_tablespace, which check cannot read. Siblings: a move
 * elsewhere, to a place the history never named, after a rename of the tablespace or a move of all
 * of it, and of a relation dropped and made again.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const HISTORY = `CREATE TABLE plain (id int);
CREATE UNLOGGED TABLE scratch (id int);
CREATE TABLE placed (id int) USING heap TABLESPACE fast;
CREATE MATERIALIZED VIEW mv USING heap TABLESPACE fast AS SELECT 1 AS id;
CREATE MATERIALIZED VIEW mv_plain AS SELECT 1 AS id;
CREATE INDEX placed_id ON placed (id) TABLESPACE fast;
CREATE INDEX plain_id ON plain (id);
`

/** `later`'s rating after HISTORY and `more`, all read as Postgres */
const rate = (later: string, more = "") =>
	classifyMigration(later, { before: extractSchema(`${HISTORY}${more}`, undefined, "postgres"), dialect: "postgres" })

const REWRITES = "rewrites or scans the table under an exclusive lock"

describe("a move to where the history left the relation (PA17 of r22b)", () => {
	it.each([
		["ALTER TABLE plain SET LOGGED;", ""],
		["ALTER TABLE scratch SET UNLOGGED;", ""],
		["ALTER TABLE placed SET ACCESS METHOD heap;", ""],
		["ALTER TABLE placed SET TABLESPACE fast;", ""],
		["ALTER MATERIALIZED VIEW mv SET ACCESS METHOD heap;", ""],
		["ALTER MATERIALIZED VIEW mv SET TABLESPACE fast;", ""],
		["ALTER INDEX placed_id SET TABLESPACE fast;", ""],
		["ALTER TABLE plain SET TABLESPACE fast;", "ALTER TABLE plain SET TABLESPACE fast;\n"],
		["ALTER TABLE plain SET ACCESS METHOD heap;", "ALTER TABLE plain SET ACCESS METHOD heap;\n"],
		["ALTER TABLE plain SET UNLOGGED;", "ALTER TABLE plain SET UNLOGGED;\n"],
		["ALTER TABLE scratch SET LOGGED;", "ALTER TABLE scratch SET LOGGED;\n"],
		["ALTER INDEX plain_id SET TABLESPACE fast;", "ALTER INDEX plain_id SET TABLESPACE fast;\n"],
		["ALTER TABLE kept SET TABLESPACE fast;", "ALTER TABLE placed RENAME TO kept;\n"],
		["ALTER TABLE s.placed SET TABLESPACE fast;", "CREATE SCHEMA s;\nALTER TABLE placed SET SCHEMA s;\n"],
		[
			"ALTER TABLE b.t SET TABLESPACE fast;",
			"CREATE SCHEMA a;\nCREATE TABLE a.t (id int) TABLESPACE fast;\nALTER SCHEMA a RENAME TO b;\n",
		],
		["ALTER INDEX kept_id SET TABLESPACE fast;", "ALTER INDEX placed_id RENAME TO kept_id;\n"],
		["ALTER TABLE placed SET TABLESPACE old;", "ALTER TABLESPACE fast RENAME TO old;\n"],
		["ALTER TABLE c SET UNLOGGED;", "CREATE UNLOGGED TABLE c AS SELECT 1 AS id;\n"],
		["ALTER TABLE c SET TABLESPACE fast;", "CREATE TABLE c TABLESPACE fast AS SELECT 1 AS id;\n"],
		["ALTER TABLE c SET UNLOGGED;", "SELECT 1 AS id INTO UNLOGGED c;\n"],
		["ALTER TABLE plain SET LOGGED, SET TABLESPACE fast;", "ALTER TABLE plain SET TABLESPACE fast;\n"],
	])("warns of nothing for %j after %j", (later, more) => {
		const rated = rate(later, more)
		expect(rated.lockWarnings).toEqual([])
		expect(rated.safety).toBe("safe")
	})

	it("follows the file's own move, so the second move to the same place warns of nothing", () => {
		const sql = "ALTER TABLE plain SET TABLESPACE fast;\nALTER TABLE plain SET TABLESPACE fast;"
		expect(rate(sql).lockWarnings).toEqual([`ALTER TABLE plain SET TABLESPACE fast (${REWRITES})`])
	})
})

describe("a move the history does not show is a no-op (siblings of PA17 of r22b)", () => {
	it.each([
		/* made without USING or TABLESPACE: the target's defaults decide where it is */
		["ALTER TABLE plain SET ACCESS METHOD heap;", ""],
		["ALTER TABLE plain SET TABLESPACE pg_default;", ""],
		["ALTER MATERIALIZED VIEW mv_plain SET TABLESPACE pg_default;", ""],
		["ALTER INDEX plain_id SET TABLESPACE fast;", ""],
		["ALTER TABLE placed SET ACCESS METHOD DEFAULT;", ""],
		/* a move elsewhere */
		["ALTER TABLE placed SET TABLESPACE slow;", ""],
		["ALTER TABLE placed SET ACCESS METHOD other;", ""],
		["ALTER INDEX placed_id SET TABLESPACE slow;", ""],
		/* the tablespace renamed, or every relation in it moved, or the relation made again */
		["ALTER TABLE placed SET TABLESPACE fast;", "ALTER TABLESPACE fast RENAME TO old;\n"],
		["ALTER INDEX placed_id SET TABLESPACE fast;", "ALTER TABLESPACE fast RENAME TO old;\n"],
		["ALTER TABLE placed SET TABLESPACE fast;", "ALTER TABLE ALL IN TABLESPACE fast SET TABLESPACE slow;\n"],
		["ALTER INDEX placed_id SET TABLESPACE fast;", "ALTER INDEX ALL IN TABLESPACE fast SET TABLESPACE slow;\n"],
		["ALTER TABLE placed SET TABLESPACE fast;", "DROP TABLE placed;\nCREATE TABLE placed (id int);\n"],
		["ALTER TABLE ghost SET TABLESPACE fast;", ""],
	])("warns of the rewrite for %j after %j", (later, more) => {
		expect(rate(later, more).lockWarnings).toEqual([`${later.slice(0, -1)} (${REWRITES})`])
	})

	it("rates a change of persistence cautious, with the rewrite, and one the history does not show the same", () => {
		for (const [later, more] of [
			["ALTER TABLE scratch SET LOGGED;", ""],
			["ALTER TABLE plain SET LOGGED;", "ALTER TABLE plain SET UNLOGGED;\n"],
			["ALTER TABLE ghost SET LOGGED;", ""],
			["ALTER TABLE placed SET LOGGED;", "DROP TABLE placed;\nCREATE UNLOGGED TABLE placed (id int);\n"],
		]) {
			const rated = rate(later as string, more)
			expect(rated.safety, later).toBe("cautious")
			expect(rated.lockWarnings, later).toEqual([`${(later as string).slice(0, -1)} (${REWRITES})`])
		}
	})
})
