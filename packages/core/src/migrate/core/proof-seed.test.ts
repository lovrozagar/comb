import { afterEach, describe, expect, it } from "vitest"
import { type MemoryDb, openMemory } from "../drivers/memory.ts"
import { quote, seedTables } from "./proof-seed.ts"

const open: MemoryDb[] = []
afterEach(() => {
	for (const db of open.splice(0)) db.close()
})

/** An in-memory database holding `schema`, seeded; returns what it could not seed and the rows of each table */
async function seeded(schema: Record<string, string>) {
	const db = await openMemory()
	open.push(db)
	for (const sql of Object.values(schema)) db.exec(sql)
	const unproven = seedTables(db, new Map(Object.entries(schema)))
	const rows = (table: string) => db.all(`SELECT * FROM ${quote(table)}`)
	return { rows, unproven }
}

describe("seedTables", () => {
	it("makes six rows: defaults, three distinct values, NULLs, and a repeat of row 1 where the table allows it", async () => {
		const { rows, unproven } = await seeded({
			t: "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT DEFAULT 'd', b TEXT NOT NULL)",
		})
		expect(unproven).toEqual(new Map())
		/* by key, as the rowid orders them: row 0 is 42 (no default for id), the repeats 99 and 100 */
		expect(rows("t").map((row) => [row["id"], row["a"], row["b"]])).toEqual([
			[-1, "Mixed Case", "Mixed Case"],
			[7, "007", "007"],
			[42, "d", "010"],
			[99, null, "007"],
			[100, "007", "007"],
			[2_147_483_648, "ñandú Ü", "ñandú Ü"],
		])
	})

	it("fills a table of defaults only, and takes a composite key's parent rows by its primary key", async () => {
		const { rows, unproven } = await seeded({
			child: "CREATE TABLE child (a TEXT NOT NULL, b INTEGER NOT NULL, FOREIGN KEY (a, b) REFERENCES parent)",
			only_defaults: "CREATE TABLE only_defaults (n INTEGER DEFAULT 1)",
			parent: "CREATE TABLE parent (x TEXT, y INTEGER, PRIMARY KEY (x, y))",
		})
		expect(unproven).toEqual(new Map())
		expect(rows("only_defaults")[0]).toEqual({ n: 1 })
		const parents = rows("parent").map((row) => `${String(row["x"])}|${String(row["y"])}`)
		for (const row of rows("child")) expect(parents).toContain(`${String(row["a"])}|${String(row["b"])}`)
	})

	it("calls unproven a table whose key comb cannot fill, and one whose seeded rows break their key", async () => {
		const { unproven } = await seeded({
			bad: "CREATE TABLE bad (id INTEGER PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) = 11))",
			orphan: "CREATE TABLE orphan (b INTEGER NOT NULL REFERENCES bad(id))",
			parent: "CREATE TABLE parent (id TEXT PRIMARY KEY)",
			retyped: "CREATE TABLE retyped (p INTEGER REFERENCES parent(id))",
		})
		expect(unproven.get("bad")).toMatch(/CHECK constraint failed/)
		expect(unproven.get("orphan")).toBe("a key it may not leave NULL references a table comb could not seed")
		expect(unproven.get("retyped")).toBe("its seeded rows break its key to parent")
	})

	it("seeds a cycle and a key to a table it does not seed, leaving each such key NULL, and a parent of two children once", async () => {
		const { rows, unproven } = await seeded({
			a: "CREATE TABLE a (id INTEGER PRIMARY KEY, b INTEGER REFERENCES b(id))",
			b: "CREATE TABLE b (id INTEGER PRIMARY KEY, a INTEGER REFERENCES a(id))",
			c: "CREATE TABLE c (id INTEGER PRIMARY KEY, a INTEGER REFERENCES a(id), gone INTEGER REFERENCES elsewhere(id))",
		})
		expect(unproven).toEqual(new Map())
		expect(rows("c").every((row) => row["gone"] === null)).toBe(true)
		expect(rows("a")).toHaveLength(6)
	})

	it("takes a CHECK … IN list's values, numbers included", async () => {
		const { rows } = await seeded({
			e: "CREATE TABLE e (k TEXT NOT NULL CHECK (k IN ('a', 'it''s')), n INTEGER NOT NULL CHECK (n IN (1, -2)))",
		})
		expect(new Set(rows("e").map((row) => row["k"]))).toEqual(new Set(["a", "it's"]))
		expect(new Set(rows("e").map((row) => row["n"]))).toEqual(new Set([1, -2]))
	})
})
