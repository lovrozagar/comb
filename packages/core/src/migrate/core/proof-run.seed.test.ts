import { afterEach, describe, expect, it } from "vitest"
import { libsqlConnection, type LibsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { type Proof, provePending } from "./proof-run.ts"

const open: LibsqlConnection[] = []
afterEach(async () => {
	for (const conn of open.splice(0)) await conn.close()
})

/** Each pending file's proof on a database `live` made */
async function proveAll(live: string, files: ReadonlyArray<[string, string]>): Promise<Map<string, Proof>> {
	const conn = libsqlConnection()
	open.push(conn)
	await conn.client.executeMultiple(live)
	return provePending(
		conn,
		files.map(([name, sql]) => ({ name, sql })),
	)
}

const prove = async (live: string, file: string) => (await proveAll(live, [["1.sql", file]])).get("1.sql") as Proof

const K = "CREATE TABLE k (id INTEGER PRIMARY KEY, a TEXT, b TEXT);"
/* Atlas's rebuild of k copying `copy`: an insert into a new table, which only the row compare can judge */
const rebuildK = (copy: string, b = "b TEXT") =>
	`CREATE TABLE new_k (id INTEGER PRIMARY KEY, a TEXT, ${b});\nINSERT INTO new_k (id, a, b) SELECT ${copy} FROM k;\nDROP TABLE k;\nALTER TABLE new_k RENAME TO k;`

/* M10 of the 0.12 round: a change that is an identity on every seeded row proves nothing */
describe("the seed against changes that keep its own rows", () => {
	it.each([
		["a NULL filled from another column", "id, a, coalesce(b, a)", "changes values of k.b"],
		["a trim", "id, trim(a), b", "changes values of k.a"],
		["an empty string made NULL", "id, NULLIF(a, ''), b", "changes values of k.a"],
	])("catches %s", async (_label, copy, found) => {
		expect((await prove(K, rebuildK(copy))).unsafe).toContain(found)
	})

	it("seeds a NULL beside a value in every row that holds NULLs", async () => {
		/* a copy of a nullable column into a NOT NULL one now meets a NULL only in that column */
		const proof = await prove(K, rebuildK("id, a, b", "b TEXT NOT NULL"))
		expect(proof.failed).toMatch(/NOT NULL constraint failed: new_k\.b/)
	})
})

/* M11 of the 0.12 round: common column shapes the seed could not meet left a table unproven */
describe("the seed against common column shapes", () => {
	it.each([
		["a STRICT table's BLOB column", "CREATE TABLE h (id INTEGER PRIMARY KEY, hash BLOB, email TEXT) STRICT;"],
		[
			"a CHECK on typeof blob",
			"CREATE TABLE h (id INTEGER PRIMARY KEY, hash ANY CHECK (typeof(hash) = 'blob'), email TEXT);",
		],
		[
			"a 64-character hex digest",
			"CREATE TABLE h (id INTEGER PRIMARY KEY, sha TEXT NOT NULL CHECK (length(sha) = 64), email TEXT);",
		],
		["a UUID key", "CREATE TABLE h (id TEXT PRIMARY KEY CHECK (length(id) = 36), email TEXT);"],
		[
			"a digit string",
			"CREATE TABLE h (id INTEGER PRIMARY KEY, zip TEXT NOT NULL CHECK (zip GLOB '[0-9][0-9][0-9][0-9][0-9]'), email TEXT);",
		],
		[
			"a ratio in [0, 1]",
			"CREATE TABLE h (id INTEGER PRIMARY KEY, p REAL NOT NULL CHECK (p >= 0 AND p <= 1), email TEXT);",
		],
		[
			"an epoch in milliseconds",
			"CREATE TABLE h (id INTEGER PRIMARY KEY, at INTEGER NOT NULL CHECK (at > 1600000000000), email TEXT);",
		],
	])("seeds %s, so a loss there shows", async (_label, live) => {
		const proof = await prove(
			live,
			"CREATE TABLE new_h AS SELECT * FROM h WHERE false;\nDELETE FROM h;\nINSERT INTO h SELECT * FROM new_h;\nDROP TABLE new_h;",
		)
		expect(proof.unproven).toEqual([])
		expect(proof.unsafe.join("\n")).toMatch(/loses 6 of the 6 rows of h/)
	})
})

/* M13 of the 0.12 round: a file the copy cannot run no longer voids the proof of every later file */
describe("the proof after a file the copy cannot run", () => {
	it("proves each later file on the schema the failed file leaves", async () => {
		const proofs = await proveAll(K, [
			["1_strict.sql", rebuildK("id, a, b", "b TEXT NOT NULL")],
			["2_new.sql", "CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);"],
			[
				"3_lossy.sql",
				"CREATE TABLE keep AS SELECT * FROM k WHERE false;\nDROP TABLE k;\nALTER TABLE keep RENAME TO k;",
			],
		])
		expect(proofs.get("1_strict.sql")?.failed).toMatch(/NOT NULL constraint failed/)
		expect(proofs.get("2_new.sql")).toEqual({ cautious: [], unproven: [], unsafe: [] })
		expect(proofs.get("3_lossy.sql")?.unsafe.join("\n")).toMatch(/loses 6 of the 6 rows of k/)
	})

	it("seeds a column a pending file reads as JSON with JSON", async () => {
		const proofs = await proveAll("CREATE TABLE u (id INTEGER PRIMARY KEY, meta TEXT);", [
			["1_plan.sql", "ALTER TABLE u ADD COLUMN plan TEXT;\nUPDATE u SET plan = json_extract(meta, '$.plan');"],
		])
		expect(proofs.get("1_plan.sql")?.failed).toBeUndefined()
	})
})

/* M14 of the 0.12 round: only a virtual table's own module's shadow tables are skipped */
describe("the copy beside a virtual table", () => {
	it("makes a real table whose name ends in another module's shadow suffix", async () => {
		const proof = await prove(
			"CREATE VIRTUAL TABLE docs USING fts5 (body);\nCREATE TABLE docs_stat (id INTEGER PRIMARY KEY, views INTEGER);",
			"INSERT INTO docs_stat (views) VALUES (1);",
		)
		expect(proof).toEqual({ cautious: [], unproven: [], unsafe: [] })
	})
})

/* P1–P4 of the 2.4 review */
describe("the seed against fills between any two nullable columns (P1)", () => {
	it("catches a fill between nullable columns a NOT NULL column parts", async () => {
		const live = "CREATE TABLE k (id INTEGER PRIMARY KEY, a TEXT, x INTEGER NOT NULL DEFAULT 0, b TEXT);"
		const copy =
			"CREATE TABLE new_k (id INTEGER PRIMARY KEY, a TEXT, x INTEGER NOT NULL DEFAULT 0, b TEXT);\nINSERT INTO new_k (id, a, x, b) SELECT id, a, x, coalesce(b, a) FROM k;\nDROP TABLE k;\nALTER TABLE new_k RENAME TO k;"
		expect((await prove(live, copy)).unsafe).toContain("changes values of k.b")
	})

	const FOUR = ["a", "b", "c", "d"]
	it.each(FOUR.flatMap((from) => FOUR.filter((to) => to !== from).map((to) => [from, to])))(
		"catches a fill of %s into %s among four nullable columns",
		async (from, to) => {
			const columns = FOUR.map((name) => (name === to ? `coalesce(${to}, ${from})` : name)).join(", ")
			const file = `CREATE TABLE new_n (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT, d TEXT);\nINSERT INTO new_n (id, a, b, c, d) SELECT id, ${columns} FROM n;\nDROP TABLE n;\nALTER TABLE new_n RENAME TO n;`
			const proof = await prove("CREATE TABLE n (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT, d TEXT);", file)
			expect(proof.unsafe).toContain(`changes values of n.${to as string}`)
		},
	)
})

describe("the seed's JSON, the json readers, and the schema after a failed file (P2–P4)", () => {
	/* NOT NULL: a swap shows only by the values themselves, never by where NULLs fall */
	const J = "CREATE TABLE k (id INTEGER PRIMARY KEY, j TEXT NOT NULL UNIQUE, j2 TEXT NOT NULL UNIQUE);"

	it("holds JSON that differs between columns, so a swap shows (P2)", async () => {
		const swap =
			"CREATE TABLE new_k (id INTEGER PRIMARY KEY, j TEXT NOT NULL UNIQUE, j2 TEXT NOT NULL UNIQUE);\nINSERT INTO new_k (id, j, j2) SELECT id, j2, j FROM k;\nSELECT json_extract(j, '$.r'), json_extract(j2, '$.r') FROM new_k;\nDROP TABLE k;\nALTER TABLE new_k RENAME TO k;"
		expect((await prove(J, swap)).unsafe).toContain("changes values of k.j")
	})

	it("seeds JSON where a file reads a column with -> or ->> (P3)", async () => {
		const proof = await prove(J, `UPDATE k SET j2 = j ->> '$.r';\nUPDATE k SET j2 = "k".j -> '$.r';`)
		expect(proof.failed).toBeUndefined()
	})

	it("leaves the engine's own tables out of the schema a failed file leaves (P4)", async () => {
		const proofs = await proveAll(K, [
			["1_auto.sql", "CREATE TABLE s (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);\nINSERT INTO s (v) VALUES ('a');"],
			["2_strict.sql", "CREATE TABLE z (n TEXT NOT NULL);\nINSERT INTO z SELECT b FROM k;"],
			["3_new.sql", "CREATE TABLE ok (id INTEGER PRIMARY KEY);"],
		])
		expect(proofs.get("2_strict.sql")?.failed).toMatch(/NOT NULL constraint failed/)
		expect(proofs.get("3_new.sql")).toEqual({ cautious: [], unproven: [], unsafe: [] })
	})
})
