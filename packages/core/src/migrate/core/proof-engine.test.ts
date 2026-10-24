import { describe, expect, it } from "vitest"
import { FILE, type Read, START, stateOf } from "../__fixtures__/apply-parity.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { openMemory } from "../drivers/memory.ts"
import { splitSqlStatements } from "./sql-scan.ts"
import { applyToCopy, engineFindings, writtenTables } from "./proof-engine.ts"
import { provePending } from "./proof-run.ts"

/** A libsql connection's reads, each row as its columns by name */
const readOf =
	(conn: ReturnType<typeof libsqlConnection>): Read =>
	async (sql) => {
		const { columns, rows } = await conn.execute(sql)
		return rows.map((row) => Object.fromEntries(columns.map((column, i) => [column, row[i]])))
	}

describe("the proof's engine pass leaves the copy as the target's own apply leaves the target", () => {
	it("ends in the same schema and rows on node:sqlite as a libsql target does", async () => {
		const target = libsqlConnection()
		await target.client.executeMultiple(START)
		await target.batch(splitSqlStatements(FILE).map((sql) => ({ sql })))
		const copy = await openMemory()
		copy.exec(START)
		expect(applyToCopy(copy, FILE).error).toBeUndefined()
		expect(await stateOf(async (sql) => copy.all(sql))).toEqual(await stateOf(readOf(target)))
		copy.close()
		await target.close()
	})

	it("leaves the target's schema and rows as they were: the proof only reads it", async () => {
		const target = libsqlConnection()
		await target.client.executeMultiple(START)
		const before = await stateOf(readOf(target))
		const proofs = await provePending(target, [{ name: "1_m.sql", sql: FILE }])
		expect(proofs.get("1_m.sql")?.failed).toBeUndefined()
		expect(await stateOf(readOf(target))).toEqual(before)
		await target.close()
	})
})

/* the tables the engine tests write: k with two indexes, a parent its child cascades from, and an
   FTS5 table; no rows, so only the engine can see a write */
const TABLES = `CREATE TABLE k (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT UNIQUE);
CREATE INDEX k_a ON k (a);
CREATE TABLE parent (id INTEGER PRIMARY KEY);
CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent (id) ON DELETE CASCADE);
CREATE VIRTUAL TABLE notes USING fts5 (body);`

/** The unsafe notes the engine pass gives `sql` on a copy of TABLES that holds no row */
async function unsafeOf(sql: string): Promise<string[]> {
	const db = await openMemory()
	db.exec(TABLES)
	const run = applyToCopy(db, sql)
	db.close()
	expect(run.error).toBeUndefined()
	return engineFindings(run.steps, run.start).unsafe
}

/* the 0.13 review of 7f2667f: a delete SQLite codes without a Delete opcode is a delete all the same */
describe("the engine pass on a delete of every row", () => {
	it.each([
		[
			"a bare DELETE, which SQLite codes as a Clear of the table and its indexes",
			"DELETE FROM k;",
			"deletes existing rows of k",
		],
		[
			"a bare DELETE of a parent, which foreign keys code row by row",
			"DELETE FROM parent;",
			"deletes existing rows of parent",
		],
		["a bare DELETE of an FTS5 table", "DELETE FROM notes;", "writes over rows of a virtual table"],
		[
			"a bare DELETE in the trigger of a table the file creates",
			"CREATE TABLE fresh (x TEXT);\nCREATE TRIGGER f AFTER INSERT ON fresh BEGIN DELETE FROM k; END;\nINSERT INTO fresh VALUES ('x');",
			"deletes existing rows of k",
		],
	])("calls %s unsafe", async (_label, sql, note) => {
		expect((await unsafeOf(sql)).join("\n")).toContain(note)
	})

	it("names a cascade a parent's delete runs on its child", async () => {
		expect(await unsafeOf("DELETE FROM parent WHERE id = 1;")).toContain(
			"DELETE FROM parent WHERE id = 1: deletes existing rows of child",
		)
	})

	it("leaves an insert, a REINDEX, and a delete of a table the file created, to no note", async () => {
		expect(
			await unsafeOf("INSERT INTO k (a) VALUES ('x');\nREINDEX k;\nCREATE TABLE t (x TEXT);\nDELETE FROM t;"),
		).toEqual([])
	})
})

/* plan 13's RC proof: on shard-1 (14,583 columns) placing a probe on every existing column for each
   statement took about 9.7 s a statement; a statement takes probes only on the tables it writes */
/* k and its cascade as TABLES has them, a trigger that writes another table, an ON UPDATE CASCADE
   into a child, and tables nothing here writes */
const PROBED_SCHEMA = `CREATE TABLE k (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT UNIQUE);
CREATE INDEX k_a ON k (a);
CREATE TABLE src (id INTEGER PRIMARY KEY, n INTEGER);
CREATE TABLE dst (id INTEGER PRIMARY KEY, v INTEGER, w INTEGER);
CREATE TRIGGER bump AFTER INSERT ON src BEGIN UPDATE dst SET v = NEW.n; END;
CREATE TABLE owner (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
CREATE TABLE pet (id INTEGER PRIMARY KEY, code TEXT REFERENCES owner (code) ON UPDATE CASCADE, name TEXT);
${Array.from({ length: 40 }, (_, i) => `CREATE TABLE idle_${i} (id INTEGER PRIMARY KEY, x TEXT, y TEXT);`).join("\n")}`

/**
 * The engine pass over `sql`, with the columns each probe trigger it placed watched; `unknownRoot`
 * adds a write to a root page main does not hold to each probe-free EXPLAIN, as no statement here
 * can open one
 */
async function probed(sql: string, { unknownRoot = false } = {}) {
	const db = await openMemory()
	db.exec(PROBED_SCHEMA)
	const placed: string[] = []
	const counting = {
		...db,
		all: (query: string, params?: readonly unknown[]) => {
			const rows = db.all(query, params)
			const probing =
				db.all("SELECT 1 FROM temp.sqlite_schema WHERE name LIKE 'comb\\_probe\\_%' ESCAPE '\\'").length > 0
			return unknownRoot && query.startsWith("EXPLAIN ") && !probing
				? [...rows, { opcode: "OpenWrite", p1: 99, p2: 9999, p3: 0, p4: "", p5: 0 }]
				: rows
		},
		exec: (statement: string) => {
			const on = /^CREATE TEMP TRIGGER \S+ BEFORE UPDATE OF ("[^"]+") ON main\.("[^"]+")/.exec(statement)
			if (on !== null) placed.push(`${on[2]}.${on[1]}`.replaceAll('"', ""))
			db.exec(statement)
		},
	}
	const run = applyToCopy(counting, sql)
	db.close()
	expect(run.error).toBeUndefined()
	return { findings: engineFindings(run.steps, run.start), placed: [...new Set(placed)].toSorted() }
}

describe("the engine pass probes only the tables a statement writes", () => {
	it("places probes on the columns of the one table an update writes, and finds the column it assigns", async () => {
		const { findings, placed } = await probed("UPDATE k SET a = 'x';")
		expect(findings.unsafe).toEqual(["UPDATE k SET a = 'x': updates existing rows of k (a)"])
		expect(placed).toEqual(["k.a", "k.b", "k.id"])
	})

	it("probes a table a statement writes only through a trigger, and finds what the trigger assigns", async () => {
		const { findings, placed } = await probed("INSERT INTO src (n) VALUES (1);")
		expect(findings.unsafe).toEqual([
			"INSERT INTO src (n) VALUES (1): updates existing rows of dst (v)",
			"INSERT INTO src (n) VALUES (1): fires trigger bump (its WHEN is not evaluated)",
		])
		expect(placed).toEqual(["dst.id", "dst.v", "dst.w", "src.id", "src.n"])
	})

	it("probes the child an ON UPDATE CASCADE writes, and finds the key it rewrites there", async () => {
		const { findings, placed } = await probed("UPDATE owner SET code = 'x';")
		expect(findings.unsafe).toEqual([
			"UPDATE owner SET code = 'x': updates existing rows of owner (code)",
			"UPDATE owner SET code = 'x': updates existing rows of pet (code)",
		])
		expect(placed).toEqual(["owner.code", "owner.id", "pet.code", "pet.id", "pet.name"])
	})

	it("probes every table when a statement writes a root page main does not hold, and finds the same", async () => {
		const { findings, placed } = await probed("UPDATE k SET a = 'x';", { unknownRoot: true })
		expect(findings.unsafe).toEqual(["UPDATE k SET a = 'x': updates existing rows of k (a)"])
		expect(placed).toHaveLength(3 + 2 + 3 + 2 + 3 + 40 * 3)
		expect(placed).toContain("idle_39.y")
	})

	it("places no probe for a statement that writes no existing table, an index or a table it builds included", async () => {
		const { findings, placed } = await probed(
			"CREATE TABLE fresh (x TEXT);\nINSERT INTO fresh VALUES ('x');\nCREATE INDEX idle_0_x ON idle_0 (x);\nCREATE TABLE copied AS SELECT * FROM idle_1;",
		)
		expect(findings.unsafe).toEqual([])
		expect(placed).toEqual([])
	})
})

/** One opcode of a program, as EXPLAIN lists it: `p2` its root page or register, `p3` its database, `p5` its flags */
const op = (opcode: string, p2: number, { p3 = 0, p5 = 0 } = {}) => ({ opcode, p1: 0, p2, p3, p4: "", p5 })

describe("writtenTables: the existing tables a statement's program opens for writing", () => {
	const main = new Map([
		[2, "k"],
		[3, "k"],
		[4, "pet"],
	])

	it("maps a table's root and its indexes' roots to the table", () => {
		expect(writtenTables([op("OpenWrite", 2), op("OpenWrite", 3), op("OpenWrite", 4)], main)).toEqual(
			new Set(["k", "pet"]),
		)
	})

	it("leaves out the schema table, a temp database's cursor, an ephemeral table and a read", () => {
		expect(
			writtenTables(
				[
					op("OpenWrite", 1),
					op("OpenWrite", 2, { p3: 1 }),
					op("OpenEphemeral", 9),
					op("OpenAutoindex", 9),
					op("OpenRead", 4),
				],
				main,
			),
		).toEqual(new Set())
	})

	it("probes every table when a root page is unknown or held in a register", () => {
		expect(writtenTables([op("OpenWrite", 2), op("OpenWrite", 99)], main)).toBeUndefined()
		/* OPFLAG_P2ISREG (0x10): P2 names the register that holds the root page */
		expect(writtenTables([op("OpenWrite", 5, { p5: 16 })], main)).toBeUndefined()
	})

	it("leaves out a btree the program creates and opens through a register, as CREATE INDEX does", () => {
		expect(writtenTables([op("CreateBtree", 7), op("OpenWrite", 7, { p5: 17 }), op("OpenWrite", 4)], main)).toEqual(
			new Set(["pet"]),
		)
	})
})
