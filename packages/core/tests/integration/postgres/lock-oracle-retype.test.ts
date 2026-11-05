/**
 * Which retypes Postgres 17 does in place, held to comb's rating of each (PA11 of r22b, the class of
 * P12 of the 0.15.0 review). Each case runs an ALTER COLUMN … TYPE in a transaction rolled back after,
 * and reads the filenodes of the table and of each index on it, by name, before and after: a new one
 * for the table is a rewrite, and a new one for an index alone is a rebuild of it. comb rates a rewrite
 * unsafe with the rewrite warning, a rebuild unsafe with the index warning, and a retype in place safe.
 */
import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

/* TIMESTAMP(n) in capitals: no Date key, so the off-UTC pass (tests/support/off-utc.ts) skips the file */
const COLUMNS = {
	b: "varchar(10)",
	bits: "bit(5)",
	cc: 'varchar(10) COLLATE "C"',
	ch: "char(5)",
	ia: "intarr",
	d: "plainint",
	dv: "v10",
	email: "text",
	ints: "int[]",
	iv: "interval(2)",
	ivd: "interval day",
	ivf: "interval",
	m2: "int[][]",
	n: "int",
	net: "cidr",
	nm: "numeric(10, 2)",
	n0: "numeric(10)",
	t0: "TIMESTAMP(0)",
	o: "oid",
	od: "overplain",
	rc: "regclass",
	ov: "over10",
	s: "text",
	sc: "tc",
	tags: "varchar(10)[]",
	tm: "time(2)",
	ts: "TIMESTAMP(3)",
	ttz: "timetz(4)",
	tz: "timestamptz",
	vb: "varbit(5)",
	x: "xml",
}

const HISTORY = [
	"CREATE DOMAIN posint AS int CHECK (VALUE > 0);",
	"CREATE DOMAIN plainint AS int;",
	"CREATE DOMAIN nnint AS int NOT NULL;",
	"CREATE DOMAIN overpos AS posint;",
	"CREATE DOMAIN overplain AS plainint;",
	"CREATE DOMAIN v10 AS varchar(10);",
	"CREATE DOMAIN v30 AS varchar(30);",
	"CREATE DOMAIN over10 AS v10;",
	'CREATE DOMAIN tc AS text COLLATE "C";',
	"CREATE DOMAIN intarr AS int[];",
	`CREATE TABLE t (id int PRIMARY KEY, ${Object.entries(COLUMNS)
		.map(([name, type]) => `${name} ${type}`)
		.join(", ")});`,
	/* an index on each column btree can index, so a rebuild of it shows */
	...Object.keys(COLUMNS)
		.filter((name) => name !== "x")
		.map((name) => `CREATE INDEX t_${name} ON t (${name});`),
].join("\n")

type Outcome = "in place" | "rebuilds its indexes" | "rewrites"

/** What Postgres does running `statement` after HISTORY: a rewrite of t, a rebuild of an index alone, or neither */
async function postgresDoes(statement: string): Promise<Outcome> {
	return withScratchDb(async (url) => {
		const client = new pg.Client({ connectionString: url })
		await client.connect()
		try {
			await client.query(HISTORY)
			const nodes = async () =>
				new Map(
					(
						await client.query<{ node: string; relname: string }>(
							"SELECT relname, pg_relation_filenode(oid)::text AS node FROM pg_class WHERE relnamespace = 'public'::regnamespace AND (relname = 't' OR relname LIKE 't\\_%')",
						)
					).rows.map(({ node, relname }) => [relname, node]),
				)
			await client.query("BEGIN")
			const before = await nodes()
			await client.query(statement)
			const after = await nodes()
			await client.query("ROLLBACK")
			if (before.get("t") !== after.get("t")) return "rewrites"
			return [...before].some(([name, node]) => after.get(name) !== node) ? "rebuilds its indexes" : "in place"
		} finally {
			await client.end()
		}
	})
}

/** What comb says `statement` does after HISTORY */
function combSays(statement: string): Outcome {
	const rated = classifyMigration(`${statement}\n`, {
		before: extractSchema(HISTORY, undefined, "postgres"),
		dialect: "postgres",
	})
	const warned = rated.lockWarnings.join("\n")
	if (warned.includes("rewrites or scans the table")) return "rewrites"
	if (warned.includes("rebuilds every index on the column")) return "rebuilds its indexes"
	expect([rated.safety, rated.lockWarnings]).toEqual(["safe", []])
	return "in place"
}

// lookup-table: each retype, with what Postgres 17 does
const CASES: ReadonlyArray<readonly [string, Outcome]> = [
	/* the same type and modifiers, and an unbounded one of the same type */
	["ALTER TABLE t ALTER COLUMN n TYPE integer;", "in place"],
	["ALTER TABLE t ALTER COLUMN ch TYPE char(5);", "in place"],
	["ALTER TABLE t ALTER COLUMN ch TYPE bpchar;", "in place"],
	["ALTER TABLE t ALTER COLUMN ch TYPE char(8);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ch TYPE text;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN n TYPE bigint;", "rewrites"],
	/* a binary coercion, to an unbounded type only */
	["ALTER TABLE t ALTER COLUMN email TYPE varchar;", "in place"],
	["ALTER TABLE t ALTER COLUMN email TYPE varchar(100);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN email TYPE bpchar;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN email TYPE char(5);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN b TYPE text;", "in place"],
	["ALTER TABLE t ALTER COLUMN b TYPE char(10);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN bits TYPE varbit;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN bits TYPE varbit(8);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN vb TYPE bit(5);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN net TYPE inet;", "in place"],
	["ALTER TABLE t ALTER COLUMN x TYPE text;", "in place"],
	["ALTER TABLE t ALTER COLUMN o TYPE int;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN n TYPE oid;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN n TYPE regclass;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN rc TYPE oid;", "in place"],
	["ALTER TABLE t ALTER COLUMN b TYPE bpchar;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN o TYPE regclass;", "in place"],
	/* a modifier a type's length coercion proves keeps every value */
	["ALTER TABLE t ALTER COLUMN b TYPE varchar(20);", "in place"],
	["ALTER TABLE t ALTER COLUMN b TYPE varchar(5);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN vb TYPE varbit(8);", "in place"],
	["ALTER TABLE t ALTER COLUMN vb TYPE varbit(3);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN nm TYPE numeric(12, 2);", "in place"],
	["ALTER TABLE t ALTER COLUMN nm TYPE numeric;", "in place"],
	["ALTER TABLE t ALTER COLUMN nm TYPE numeric(12, 3);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN nm TYPE numeric(12);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN n0 TYPE numeric(12);", "in place"],
	["ALTER TABLE t ALTER COLUMN n0 TYPE numeric(12, 0);", "in place"],
	["ALTER TABLE t ALTER COLUMN n0 TYPE numeric(12, 1);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ts TYPE TIMESTAMP(6);", "in place"],
	["ALTER TABLE t ALTER COLUMN t0 TYPE TIMESTAMP(0);", "in place"],
	["ALTER TABLE t ALTER COLUMN t0 TYPE TIMESTAMP(3);", "in place"],
	["ALTER TABLE t ALTER COLUMN ts TYPE TIMESTAMP(0);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ts TYPE timestamp;", "in place"],
	["ALTER TABLE t ALTER COLUMN ts TYPE TIMESTAMP(2);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN tz TYPE timestamptz(6);", "in place"],
	["ALTER TABLE t ALTER COLUMN tz TYPE timestamptz(3);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN tm TYPE time(4);", "in place"],
	["ALTER TABLE t ALTER COLUMN tm TYPE time(1);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ttz TYPE timetz(6);", "in place"],
	["ALTER TABLE t ALTER COLUMN ttz TYPE timetz(2);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN iv TYPE interval;", "in place"],
	["ALTER TABLE t ALTER COLUMN iv TYPE interval(4);", "in place"],
	["ALTER TABLE t ALTER COLUMN iv TYPE interval(1);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN iv TYPE interval day;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ivd TYPE interval;", "in place"],
	["ALTER TABLE t ALTER COLUMN ivf TYPE interval second;", "in place"],
	["ALTER TABLE t ALTER COLUMN ivf TYPE interval(3);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ivf TYPE interval minute to second;", "in place"],
	["ALTER TABLE t ALTER COLUMN ivd TYPE interval day to hour;", "in place"],
	["ALTER TABLE t ALTER COLUMN ivd TYPE interval hour;", "in place"],
	["ALTER TABLE t ALTER COLUMN ivd TYPE interval month;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ivd TYPE interval day to second(0);", "in place"],
	["ALTER TABLE t ALTER COLUMN iv TYPE interval second(4);", "in place"],
	["ALTER TABLE t ALTER COLUMN iv TYPE interval hour to minute;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN iv TYPE interval day to second(4);", "in place"],
	/* an array: its element's type the same, and its modifier none or the same; its dimensions read by no one */
	["ALTER TABLE t ALTER COLUMN tags TYPE varchar[];", "in place"],
	["ALTER TABLE t ALTER COLUMN tags TYPE varchar(10)[];", "in place"],
	["ALTER TABLE t ALTER COLUMN tags TYPE varchar[][];", "in place"],
	["ALTER TABLE t ALTER COLUMN tags TYPE varchar(20)[];", "rewrites"],
	["ALTER TABLE t ALTER COLUMN tags TYPE text[];", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ints TYPE int[][];", "in place"],
	["ALTER TABLE t ALTER COLUMN m2 TYPE int[];", "in place"],
	["ALTER TABLE t ALTER COLUMN ints TYPE bigint[];", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ints TYPE plainint[];", "rewrites"],
	/* a domain: to one with no constraint up its chain, read as its base; from one, as its base unbounded */
	["ALTER TABLE t ALTER COLUMN n TYPE plainint;", "in place"],
	["ALTER TABLE t ALTER COLUMN n TYPE overplain;", "in place"],
	["ALTER TABLE t ALTER COLUMN n TYPE posint;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN n TYPE nnint;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN n TYPE overpos;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN od TYPE int;", "in place"],
	["ALTER TABLE t ALTER COLUMN od TYPE plainint;", "in place"],
	["ALTER TABLE t ALTER COLUMN d TYPE overplain;", "in place"],
	["ALTER TABLE t ALTER COLUMN b TYPE v10;", "in place"],
	["ALTER TABLE t ALTER COLUMN b TYPE v30;", "in place"],
	["ALTER TABLE t ALTER COLUMN email TYPE v30;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN dv TYPE v10;", "in place"],
	["ALTER TABLE t ALTER COLUMN dv TYPE varchar;", "in place"],
	["ALTER TABLE t ALTER COLUMN dv TYPE text;", "in place"],
	["ALTER TABLE t ALTER COLUMN dv TYPE varchar(20);", "rewrites"],
	["ALTER TABLE t ALTER COLUMN dv TYPE v30;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ov TYPE v10;", "rewrites"],
	["ALTER TABLE t ALTER COLUMN ints TYPE intarr;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN ia TYPE int[];", "rebuilds its indexes"],
	/* the collation the column ends with, a domain's when the retype names none */
	["ALTER TABLE t ALTER COLUMN cc TYPE text;", "rebuilds its indexes"],
	['ALTER TABLE t ALTER COLUMN cc TYPE text COLLATE "C";', "in place"],
	["ALTER TABLE t ALTER COLUMN s TYPE tc;", "rebuilds its indexes"],
	["ALTER TABLE t ALTER COLUMN sc TYPE text;", "rebuilds its indexes"],
	['ALTER TABLE t ALTER COLUMN sc TYPE text COLLATE "C";', "in place"],
]

describe("which retypes Postgres 17 does in place, and comb's rating of each (PA11)", () => {
	it.each(CASES)("%s %s", async (statement, outcome) => {
		expect(await postgresDoes(statement)).toBe(outcome)
		expect(combSays(statement)).toBe(outcome)
	})
})
