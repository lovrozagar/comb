/**
 * P12 of the 0.15.0 review: a retype Postgres does in place, with no rewrite and no value changed
 * (probed on Postgres 17 by s3-widening-retype.ts: the filenode stayed), rated unsafe with a rewrite
 * warning, as int to bigint is. A retype that only widens, with no USING, is safe and warns of nothing.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const HISTORY =
	"CREATE TABLE t (id int, name varchar(10), code varchar, body text, amount numeric(10, 2), flags varbit(5), n numeric); CREATE TABLE g (p geometry(Point, 4326));"

/** `later`'s rating after HISTORY and `more`, all read as Postgres */
function rate(later: string, more = "") {
	const before = extractSchema(`${HISTORY}${more}`, undefined, "postgres")
	return classifyMigration(later, { before, dialect: "postgres" })
}

describe("a retype that only widens", () => {
	it.each([
		"ALTER TABLE t ALTER COLUMN name TYPE varchar(20);",
		"ALTER TABLE t ALTER COLUMN name TYPE varchar(10);",
		"ALTER TABLE t ALTER COLUMN name TYPE varchar;",
		"ALTER TABLE t ALTER COLUMN name TYPE text;",
		"ALTER TABLE t ALTER COLUMN code TYPE text;",
		"ALTER TABLE t ALTER COLUMN amount TYPE numeric(12, 2);",
		"ALTER TABLE t ALTER COLUMN amount TYPE numeric;",
		"ALTER TABLE t ALTER COLUMN flags TYPE varbit(8);",
		"ALTER TABLE t ALTER COLUMN flags SET DATA TYPE varbit;",
	])("rates %j safe, with no lock warning", (later) => {
		const rated = rate(later)
		expect([rated.safety, rated.lockWarnings]).toEqual(["safe", []])
	})

	it("reads the column's type after a rename and an earlier widening", () => {
		const more = "ALTER TABLE t RENAME COLUMN name TO title; ALTER TABLE t ALTER COLUMN title TYPE varchar(30);"
		expect(rate("ALTER TABLE t ALTER COLUMN title TYPE varchar(40);", more).safety).toBe("safe")
		expect(rate("ALTER TABLE t ALTER COLUMN title TYPE varchar(20);", more).safety).toBe("unsafe")
	})
})

describe("a retype that may change a value or rewrite the table", () => {
	it.each([
		["a narrower varchar", "ALTER TABLE t ALTER COLUMN name TYPE varchar(5);"],
		["text to varchar(n)", "ALTER TABLE t ALTER COLUMN body TYPE varchar(100);"],
		["a widening with USING", "ALTER TABLE t ALTER COLUMN name TYPE varchar(20) USING name::varchar(20);"],
		["a numeric of another scale", "ALTER TABLE t ALTER COLUMN amount TYPE numeric(12, 3);"],
		["a smaller numeric precision", "ALTER TABLE t ALTER COLUMN amount TYPE numeric(8, 2);"],
		["an unbounded numeric bounded", "ALTER TABLE t ALTER COLUMN n TYPE numeric(10, 2);"],
		["int to bigint", "ALTER TABLE t ALTER COLUMN id TYPE bigint;"],
		["a column the history does not know", "ALTER TABLE t ALTER COLUMN ghost TYPE text;"],
		["a table the history does not know", "ALTER TABLE u ALTER COLUMN name TYPE text;"],
		/* PostGIS's modifiers are a word and a number */
		["a type whose modifiers are no numbers", "ALTER TABLE g ALTER COLUMN p TYPE geometry(Point, 4326);"],
	])("rates %s unsafe, with the rewrite warning", (_, later) => {
		const rated = rate(later)
		expect(rated.safety).toBe("unsafe")
		expect(rated.lockWarnings.join(" ")).toContain("rewrites or scans the table under an exclusive lock")
	})
})
