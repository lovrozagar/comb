import { describe, expect, it } from "vitest"
import { firstCompiled, libsqlLocal } from "./libsql-local.ts"

/* a stand-in for libsql's compile: text that ends inside a trigger's body does not compile */
const compiles = (text: string) => !/BEGIN[^;]*;$/i.test(text)

describe("firstCompiled", () => {
	it("is the text up to the first ; in code that compiles, past one in a string or comment", () => {
		expect(firstCompiled("SELECT ';'; SELECT 2;", () => true)).toBe("SELECT ';';")
		expect(firstCompiled("SELECT 1 -- a;\n; SELECT 2", () => true)).toBe("SELECT 1 -- a;\n;")
	})

	it("passes a ; that ends no statement, inside a trigger's body, and is the whole text with no end", () => {
		const trigger = "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;"
		expect(firstCompiled(`${trigger} SELECT 2;`, compiles)).toBe(trigger)
		expect(firstCompiled("SELECT 1", compiles)).toBe("SELECT 1")
	})
})

describe("libsqlLocal (SL3 of r22)", () => {
	it("runs on libsql's engine: its vector functions, rows and parameters", async () => {
		const db = (await libsqlLocal())(":memory:")
		db.exec(
			"CREATE TABLE t (id INTEGER PRIMARY KEY, emb F32_BLOB(3)); CREATE INDEX t_emb ON t (libsql_vector_idx(emb))",
		)
		db.run("INSERT INTO t (id, emb) VALUES (?, vector32(?))", [1, "[1,2,3]"])
		db.run("INSERT INTO t (id) VALUES (2)")
		expect(db.all("SELECT id, vector_extract(emb) AS v FROM t WHERE id = ?", [1])).toEqual([{ id: 1, v: "[1,2,3]" }])
		expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 2 }])
		expect(db.firstStatement("CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; SELECT 2")).toBe(
			"CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END;",
		)
		db.close()
	})

	it("commits after an EXPLAIN of a write it read, which libsql would hold active", async () => {
		const db = (await libsqlLocal())(":memory:")
		db.exec("CREATE TABLE t (v INTEGER)")
		db.exec("BEGIN")
		expect(db.all("EXPLAIN INSERT INTO t (v) VALUES (?)", [1]).length).toBeGreaterThan(0)
		db.run("INSERT INTO t (v) VALUES (2)")
		db.exec("COMMIT")
		expect(db.all("SELECT v FROM t")).toEqual([{ v: 2 }])
		db.close()
	})
})
