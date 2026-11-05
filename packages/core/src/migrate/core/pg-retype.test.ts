/**
 * P12 of the 0.15.0 review: a retype Postgres does in place, with no rewrite and no value changed
 * (probed on Postgres 17 by s3-widening-retype.ts: the filenode stayed), rated unsafe with a rewrite
 * warning, as int to bigint is. A retype that only widens, with no USING, is safe and warns of nothing.
 */
import { describe, expect, it } from "vitest"
import { classifyMigration } from "./classify.ts"
import { extractSchema } from "./schema.ts"

const HISTORY =
	"CREATE TABLE t (id int, name varchar(10), code varchar, body text, amount numeric(10, 2), whole numeric(10), flags varbit(5), n numeric); CREATE TABLE g (p geometry(Point, 4326));"

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
		"ALTER TABLE t ALTER COLUMN whole TYPE numeric(12);",
		"ALTER TABLE t ALTER COLUMN whole TYPE numeric(12, 0);",
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
		["a numeric scale dropped", "ALTER TABLE t ALTER COLUMN amount TYPE numeric(12);"],
		["an unbounded varchar bounded", "ALTER TABLE t ALTER COLUMN code TYPE varchar(20);"],
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

/*
 * r18 P1: an array to a scalar changes what the column holds, and an element retyped rewrites; PA11
 * of r22b: an array of the same element and modifier is done in place, of any dimensions
 */
describe("a retype on either side of an array", () => {
	const ARRAYS = "CREATE TABLE a (tags varchar(10)[], grid int[][], label varchar(10));"
	it.each([
		"ALTER TABLE a ALTER COLUMN tags TYPE text;",
		"ALTER TABLE a ALTER COLUMN tags TYPE varchar(20)[];",
		"ALTER TABLE a ALTER COLUMN tags TYPE text[];",
		"ALTER TABLE a ALTER COLUMN label TYPE varchar(20)[];",
		"ALTER TABLE a ALTER COLUMN label TYPE text ARRAY;",
		"ALTER TABLE a ALTER COLUMN grid TYPE bigint[][];",
	])("rates %j unsafe, with the rewrite warning", (later) => {
		const rated = rate(later, ARRAYS)
		expect([rated.safety, rated.lockWarnings.length]).toEqual(["unsafe", 1])
	})

	it.each([
		"ALTER TABLE a ALTER COLUMN tags TYPE varchar(10)[];",
		"ALTER TABLE a ALTER COLUMN tags TYPE varchar[][];",
		"ALTER TABLE a ALTER COLUMN grid TYPE int[];",
	])("rates %j safe, as each element keeps its value", (later) => {
		const rated = rate(later, ARRAYS)
		expect([rated.safety, rated.lockWarnings]).toEqual(["safe", []])
	})

	it("reads an array column's type as recorded after a rename", () => {
		const more = `${ARRAYS} ALTER TABLE a RENAME COLUMN tags TO labels;`
		expect(rate("ALTER TABLE a ALTER COLUMN labels TYPE varchar(20)[];", more).safety).toBe("unsafe")
	})
})

/* r18 P3: a retype sets the column's collation, its type's default when it names none, and a change rebuilds its indexes */
describe("a widening retype and the column's collation", () => {
	const COLLATED = 'CREATE TABLE c (plain varchar(10), coded varchar(10) COLLATE "C");'
	it.each([
		'ALTER TABLE c ALTER COLUMN plain TYPE text COLLATE "C";',
		'ALTER TABLE c ALTER COLUMN plain TYPE varchar(20) COLLATE "en-x-icu";',
		"ALTER TABLE c ALTER COLUMN coded TYPE varchar(20);",
		'ALTER TABLE c ALTER COLUMN coded TYPE text COLLATE "POSIX";',
	])("rates %j unsafe, warning that the column's indexes are rebuilt", (later) => {
		const rated = rate(later, COLLATED)
		expect(rated.safety).toBe("unsafe")
		expect(rated.lockWarnings.join("\n")).toContain("rebuilds every index on the column")
	})

	it.each([
		'ALTER TABLE c ALTER COLUMN coded TYPE varchar(20) COLLATE "C";',
		'ALTER TABLE c ALTER COLUMN coded TYPE text COLLATE pg_catalog."C";',
		'ALTER TABLE c ALTER COLUMN plain TYPE text COLLATE "default";',
		"ALTER TABLE c ALTER COLUMN plain TYPE varchar(20);",
	])("rates %j safe, as the collation it ends with is the one the column had", (later) => {
		const rated = rate(later, COLLATED)
		expect([rated.safety, rated.lockWarnings]).toEqual(["safe", []])
	})

	it("reads the collation an earlier retype left", () => {
		const more = `${COLLATED} ALTER TABLE c ALTER COLUMN plain TYPE varchar(10) COLLATE "C";`
		expect(rate('ALTER TABLE c ALTER COLUMN plain TYPE varchar(30) COLLATE "C";', more).safety).toBe("safe")
	})
})

/* PA11 of r22b: the retypes Postgres 17 does in place beyond a widening, and what still rewrites */
/* TIMESTAMP(n) in capitals: no Date key, so the off-UTC pass (tests/support/off-utc.ts) skips the file */
const MORE = [
	"CREATE DOMAIN plain AS int; CREATE DOMAIN checked AS int CHECK (VALUE > 0); CREATE DOMAIN over AS plain;",
	"CREATE DOMAIN short AS varchar(10); CREATE DOMAIN arr AS int[];",
	"CREATE TABLE m (i int, ch char(5), x xml, net cidr, ts TIMESTAMP(3), t0 TIMESTAMP(0), tm time(2), ivd interval day,",
	"iv interval(2), ivf interval, d plain, s short, a int[], da arr, ib int);",
	"CREATE INDEX ON m (ib);",
].join(" ")

describe("a retype by a coercion that changes no value", () => {
	it.each([
		"ALTER TABLE m ALTER COLUMN i TYPE integer;",
		"ALTER TABLE m ALTER COLUMN ch TYPE bpchar;",
		"ALTER TABLE m ALTER COLUMN x TYPE text;",
		"ALTER TABLE m ALTER COLUMN net TYPE inet;",
		"ALTER TABLE m ALTER COLUMN i TYPE plain;",
		"ALTER TABLE m ALTER COLUMN i TYPE over;",
		"ALTER TABLE m ALTER COLUMN d TYPE int;",
		"ALTER TABLE m ALTER COLUMN s TYPE text;",
		"ALTER TABLE m ALTER COLUMN ts TYPE TIMESTAMP(6);",
		"ALTER TABLE m ALTER COLUMN ts TYPE TIMESTAMP(4);",
		"ALTER TABLE m ALTER COLUMN t0 TYPE TIMESTAMP(0);",
		"ALTER TABLE m ALTER COLUMN t0 TYPE TIMESTAMP(3);",
		"ALTER TABLE m ALTER COLUMN tm TYPE time(6);",
		"ALTER TABLE m ALTER COLUMN ivd TYPE interval hour;",
		"ALTER TABLE m ALTER COLUMN ivd TYPE interval day to second(0);",
		"ALTER TABLE m ALTER COLUMN iv TYPE interval(4);",
		"ALTER TABLE m ALTER COLUMN iv TYPE interval second(2);",
		"ALTER TABLE m ALTER COLUMN ivf TYPE interval second;",
	])("rates %j safe, with no lock warning", (later) => {
		const rated = rate(later, MORE)
		expect([rated.safety, rated.lockWarnings]).toEqual(["safe", []])
	})

	it.each([
		"ALTER TABLE m ALTER COLUMN ch TYPE char(8);",
		"ALTER TABLE t ALTER COLUMN body TYPE char(5);",
		"ALTER TABLE m ALTER COLUMN i TYPE checked;",
		"ALTER TABLE m ALTER COLUMN s TYPE varchar(20);",
		"ALTER TABLE m ALTER COLUMN ts TYPE TIMESTAMP(2);",
		"ALTER TABLE m ALTER COLUMN tm TYPE time(1);",
		"ALTER TABLE m ALTER COLUMN ivd TYPE interval month;",
		"ALTER TABLE m ALTER COLUMN iv TYPE interval(1);",
		"ALTER TABLE m ALTER COLUMN ivf TYPE interval(3);",
		"ALTER TABLE m ALTER COLUMN iv TYPE interval hour to minute;",
		"ALTER TABLE m ALTER COLUMN a TYPE plain[];",
	])("rates %j unsafe, with the rewrite warning", (later) => {
		const rated = rate(later, MORE)
		expect(rated.safety).toBe("unsafe")
		expect(rated.lockWarnings.join(" ")).toContain("rewrites or scans the table under an exclusive lock")
	})
})

/* PA11 of r22b: a retype that keeps every value can still rebuild the column's indexes */
describe("a retype by a coercion that rebuilds the column's indexes", () => {
	it.each([
		"ALTER TABLE m ALTER COLUMN ib TYPE oid;",
		"ALTER TABLE t ALTER COLUMN body TYPE bpchar;",
		"ALTER TABLE m ALTER COLUMN a TYPE arr;",
		"ALTER TABLE m ALTER COLUMN da TYPE int[];",
	])("rates %j unsafe, warning that the column's indexes are rebuilt", (later) => {
		const rated = rate(later, MORE)
		expect(rated.safety).toBe("unsafe")
		expect(rated.lockWarnings.join("\n")).toContain("rebuilds every index on the column")
	})

	/* the rebuild shows the element followed: an element read under its old name would rewrite */
	it.each([
		[
			"a domain renamed",
			"ALTER TABLE m ADD COLUMN pa plain[]; CREATE DOMAIN plains AS plain[]; ALTER DOMAIN plain RENAME TO whole;",
			"plains",
		],
		[
			"its schema renamed",
			"CREATE SCHEMA k; CREATE DOMAIN k.e AS int; CREATE DOMAIN k.es AS k.e[]; ALTER TABLE m ADD COLUMN pa k.e[]; ALTER SCHEMA k RENAME TO j;",
			"j.es",
		],
	])("follows an array domain's element through %s", (_, more, type) => {
		const history = `${MORE} ${more}`
		const rated = rate(`ALTER TABLE m ALTER COLUMN pa TYPE ${type};`, history)
		expect(rated.lockWarnings.join("\n")).toContain("rebuilds every index on the column")
	})
})
