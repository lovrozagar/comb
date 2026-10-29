/**
 * P8 of the 0.15.0 review: Postgres rewrites the table for an added column whose default is
 * volatile, which every function is unless it says otherwise. comb warned only for eight named
 * built-ins, so a history function and an unlisted built-in such as random_normal() rewrote the
 * table with no warning (probed on Postgres 17 by d6-volatile-default-rewrite.ts: filenode changed).
 * A default that calls a function is a rewrite unless the function is known not to be volatile.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const TABLE = "CREATE TABLE t (id int);"

/** `later`'s lock warnings after `history`, both read as Postgres */
function warnings(history: string, later: string): string[] {
	const before = extractSchema(`${TABLE}${history}`, undefined, "postgres")
	return classifyMigration(later, { before, dialect: "postgres" }).lockWarnings
}

const REWRITE = "(rewrites or scans the table under an exclusive lock)"
const fn = (volatility: string) => `CREATE FUNCTION next_code() RETURNS int LANGUAGE sql ${volatility} AS 'SELECT 1';`

describe("an added column's default that calls a function", () => {
	it.each([
		["a built-in no list names as steady", "", "ALTER TABLE t ADD COLUMN b float8 DEFAULT random_normal();"],
		["a history function that says nothing", fn(""), "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();"],
		["a history function that says VOLATILE", fn("VOLATILE"), "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();"],
		[
			"a history function made IMMUTABLE, then altered back",
			`${fn("IMMUTABLE")} ALTER FUNCTION next_code() VOLATILE;`,
			"ALTER TABLE t ADD COLUMN a int DEFAULT next_code();",
		],
		["a call inside a cast", "", "ALTER TABLE t ADD COLUMN e text DEFAULT random()::text;"],
	])("warns of the rewrite for %s", (_, history, later) => {
		expect(warnings(history, later)).toEqual([`${later.slice(0, -1)} ${REWRITE}`])
	})

	it.each([
		["now()", "", "ALTER TABLE t ADD COLUMN c timestamptz DEFAULT now();"],
		["a qualified steady built-in", "", "ALTER TABLE t ADD COLUMN c timestamptz DEFAULT pg_catalog.now();"],
		["a history function that says IMMUTABLE", fn("IMMUTABLE"), "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();"],
		["a history function that says STABLE", fn("STABLE"), "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();"],
		[
			"a history function altered to STABLE",
			`${fn("")} ALTER FUNCTION next_code() STABLE;`,
			"ALTER TABLE t ADD COLUMN a int DEFAULT next_code();",
		],
		["a constant", "", "ALTER TABLE t ADD COLUMN f int DEFAULT 7;"],
	])("warns of none for %s, which Postgres evaluates once", (_, history, later) => {
		expect(warnings(history, later)).toEqual([])
	})

	it("follows an ALTER FUNCTION without its arguments, and passes over one that sets no volatility or names no history routine", () => {
		const altered = `${fn("")} ALTER FUNCTION next_code STABLE; ALTER FUNCTION next_code() SECURITY DEFINER; ALTER FUNCTION ghost() VOLATILE;`
		expect(warnings(altered, "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();")).toEqual([])
	})

	it("gives an ALTER FUNCTION's volatility to the overload it names alone", () => {
		const overloads = `${fn("")} CREATE FUNCTION next_code(n int) RETURNS int LANGUAGE sql AS 'SELECT n'; ALTER FUNCTION next_code(int) IMMUTABLE;`
		expect(warnings(overloads, "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();")).toEqual([
			`ALTER TABLE t ADD COLUMN a int DEFAULT next_code() ${REWRITE}`,
		])
		const both = `${overloads} ALTER FUNCTION next_code() STABLE;`
		expect(warnings(both, "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();")).toEqual([])
	})

	it("warns for a history function renamed from a steady one only by what the new name's CREATE says", () => {
		const renamed = `${fn("IMMUTABLE")} ALTER FUNCTION next_code() RENAME TO code;`
		expect(warnings(renamed, "ALTER TABLE t ADD COLUMN a int DEFAULT code();")).toEqual([])
	})

	it("warns when any overload of the history function is volatile, as comb cannot tell which the call takes", () => {
		const overloads = `${fn("IMMUTABLE")} CREATE FUNCTION next_code(n int) RETURNS int LANGUAGE sql AS 'SELECT n';`
		expect(warnings(overloads, "ALTER TABLE t ADD COLUMN a int DEFAULT next_code();")).toEqual([
			`ALTER TABLE t ADD COLUMN a int DEFAULT next_code() ${REWRITE}`,
		])
	})
})
