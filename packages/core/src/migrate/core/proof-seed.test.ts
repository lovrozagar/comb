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
	const unproven = seedTables(db, new Map(Object.entries(schema)), { json: new Set(), variant: 0 })
	const rows = (table: string) => db.all(`SELECT * FROM ${quote(table)}`)
	return { rows, unproven }
}

describe("seedTables", () => {
	it("makes six rows: defaults, three distinct values, staggered NULLs, and no repeat down a column", async () => {
		const { rows, unproven } = await seeded({
			t: "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT DEFAULT 'd', b TEXT NOT NULL)",
		})
		expect(unproven).toEqual(new Map())
		/* by key, each past 2^40: row 0 is 42; each column's values carry its position (G1b), before any
		   trailing whitespace; row 0 holds an empty string where no default fills it, and rows 4 and 5
		   leave alternate columns NULL, holding outer whitespace in the others (M10) */
		const K = 2 ** 40
		expect(rows("t").map((row) => [row["id"], row["a"], row["b"]])).toEqual([
			[-1 - K, "Mixed Case1", "Mixed Case2"],
			[7 + K, "0071", "0072"],
			[42 + K, "d", ""],
			[99 + K, " x1 ", " x2 "],
			[100 + K, null, " zZ2 "],
			[2_147_483_648 + K, "ñandú Ü1", "ñandú Ü2"],
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
			bad: "CREATE TABLE bad (id INTEGER PRIMARY KEY, code TEXT NOT NULL CHECK (length(code) = 20))",
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
})

describe("seedTables on CHECK constraints", () => {
	it("seeds a row a CHECK refuses with the table's defaults, then another slot's values", async () => {
		const { rows, unproven } = await seeded({
			grant:
				"CREATE TABLE grant (id TEXT PRIMARY KEY, credits INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, CHECK (credits >= 1), CHECK (used <= credits))",
		})
		expect(unproven).toEqual(new Map())
		expect(rows("grant")).toHaveLength(6)
	})

	it("takes a CHECK … IN list's values, numbers included", async () => {
		const { rows } = await seeded({
			e: "CREATE TABLE e (k TEXT NOT NULL CHECK (k IN ('a', 'it''s')), n INTEGER NOT NULL CHECK (n IN (1, -2)))",
		})
		expect(new Set(rows("e").map((row) => row["k"]))).toEqual(new Set(["a", "it's"]))
		expect(new Set(rows("e").map((row) => row["n"]))).toEqual(new Set([1, -2]))
	})
})

describe("seedTables on mixed-case names and self-references (M14)", () => {
	it("seeds the children of a parent named in mixed case, and points a self-reference at an earlier row", async () => {
		const { rows, unproven } = await seeded({
			User: 'CREATE TABLE "User" (id TEXT PRIMARY KEY, managerId TEXT REFERENCES "User" (id))',
			Post: 'CREATE TABLE "Post" (id TEXT PRIMARY KEY, authorId TEXT NOT NULL REFERENCES "User" (id))',
		})
		expect(unproven).toEqual(new Map())
		const users = rows("User").map((row) => row["id"])
		expect(rows("Post").every((row) => users.includes(row["authorId"]))).toBe(true)
		expect(rows("User").filter((row) => row["managerId"] !== null).length).toBeGreaterThan(0)
	})
})

describe("seedTables on common CHECK shapes (M15)", () => {
	it.each([
		["json_valid(meta)", "meta TEXT NOT NULL CHECK (json_valid(meta))"],
		["an email shape", "email TEXT NOT NULL CHECK (email LIKE '%_@_%')"],
		["a fixed length", "uid TEXT NOT NULL CHECK (length(uid) = 26)"],
		["a percentage range", "pct INTEGER NOT NULL CHECK (pct >= 0 AND pct <= 100)"],
		["a type on a nullable column", "n INTEGER CHECK (typeof(n) = 'integer')"],
		/* M47: text datetime() keeps as written, YYYY-MM-DD HH:MM:SS */
		["a datetime text", "at TEXT NOT NULL CHECK (at IS datetime(at))"],
		/* C14 of the 0.14.1 review: shapes anyrow's tables use, which every attempt so far refused */
		["one of two left NULL", "a TEXT, b TEXT, CHECK (a IS NULL OR b IS NULL)"],
		[
			"an expiry after a creation time its default sets now",
			"created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), expires_at INTEGER NOT NULL, CHECK (expires_at > created_at)",
		],
	])("seeds a table checked by %s", async (_, column) => {
		const { rows, unproven } = await seeded({ t: `CREATE TABLE t (id INTEGER PRIMARY KEY, ${column})` })
		expect(unproven).toEqual(new Map())
		expect(rows("t")).toHaveLength(6)
	})

	/* M47: keys start past 2^40, so a key held to 32 bits takes a fallback counting down from 2^31 - 1 */
	it("seeds an INTEGER key a CHECK holds to 32 bits", async () => {
		const { rows, unproven } = await seeded({
			t: "CREATE TABLE t (id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 2147483647), a TEXT)",
		})
		expect(unproven).toEqual(new Map())
		expect(rows("t")).toHaveLength(6)
	})

	it("repeats no value across rows in a column that allows a repeat", async () => {
		const { rows } = await seeded({ t: "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL, n INTEGER NOT NULL)" })
		for (const column of ["a", "n"]) expect(new Set(rows("t").map((row) => row[column])).size).toBe(6)
		expect(rows("t").every((row) => Math.abs(Number(row["id"])) >= 2 ** 40)).toBe(true)
	})
})

describe("seedTables on a table that fails after a row broke its key", () => {
	it("keeps why a table failed to seed over its broken key, its name folded however it was written", async () => {
		const db = await openMemory()
		open.push(db)
		const schema = {
			Kid: "CREATE TABLE Kid (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id))",
			parent: "CREATE TABLE parent (id TEXT PRIMARY KEY)",
		}
		for (const sql of Object.values(schema)) db.exec(sql)
		/* the second row breaks the key to parent, and the third is refused */
		db.exec(
			"CREATE TRIGGER full BEFORE INSERT ON Kid WHEN (SELECT count(*) FROM Kid) >= 2 BEGIN SELECT RAISE(ABORT, 'full'); END",
		)
		const unproven = seedTables(db, new Map(Object.entries(schema)), { json: new Set(), variant: 0 })
		expect(Object.fromEntries(unproven)).toEqual({ kid: "full" })
	})
})
