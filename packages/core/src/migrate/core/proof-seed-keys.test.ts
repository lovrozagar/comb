import { afterEach, describe, expect, it } from "vitest"
import { type LocalDb, openMemory } from "../drivers/local-db.ts"
import { keyGroups, keyScope, keysOf } from "./proof-seed-keys.ts"

const open: LocalDb[] = []
afterEach(() => {
	for (const db of open.splice(0)) db.close()
})

describe("keyGroups (SD1 of r22, 8.4)", () => {
	it("puts each parent's group first, a cycle in one group in the order given, and a table in none alone", async () => {
		const db = await openMemory()
		open.push(db)
		const schema = {
			Kid: "CREATE TABLE Kid (id INTEGER PRIMARY KEY, a INTEGER REFERENCES A (id), p INTEGER REFERENCES p (id))",
			a: "CREATE TABLE a (id INTEGER PRIMARY KEY, b INTEGER REFERENCES b (id))",
			b: "CREATE TABLE b (id INTEGER PRIMARY KEY, a INTEGER REFERENCES a (id), up INTEGER REFERENCES b (id))",
			p: "CREATE TABLE p (id INTEGER PRIMARY KEY, gone INTEGER REFERENCES elsewhere (id))",
		}
		for (const sql of Object.values(schema)) db.exec(sql)
		/* SQLite lists a table's keys last first, so Kid reaches p before a */
		expect(keyGroups(db, Object.keys(schema))).toEqual([["p"], ["a", "b"], ["Kid"]])
	})

	it("reads a composite key's columns together, and a key that names no columns as none", async () => {
		const db = await openMemory()
		open.push(db)
		db.exec("CREATE TABLE p (x TEXT, y INTEGER, PRIMARY KEY (x, y))")
		db.exec("CREATE TABLE c (a TEXT, b INTEGER, FOREIGN KEY (a, b) REFERENCES P)")
		expect(keysOf(db, "c")).toEqual([{ from: ["a", "b"], table: "p", to: [] }])
	})
})

describe("keyScope (8.5 of plan 21)", () => {
	it("holds the touched tables, their descendants and every ancestor of both, and no name that is not a table", async () => {
		const db = await openMemory()
		open.push(db)
		const schema = {
			Org: "CREATE TABLE Org (id INTEGER PRIMARY KEY, gone INTEGER REFERENCES elsewhere (id))",
			team: "CREATE TABLE team (id INTEGER PRIMARY KEY, org INTEGER REFERENCES Org (id))",
			member: "CREATE TABLE member (id INTEGER PRIMARY KEY, team INTEGER REFERENCES team (id))",
			sibling: "CREATE TABLE sibling (id INTEGER PRIMARY KEY, org INTEGER REFERENCES org (id))",
		}
		for (const sql of Object.values(schema)) db.exec(sql)
		const scope = keyScope(db, Object.keys(schema), new Set(["team", "not_a_table"]))
		expect([...scope].toSorted()).toEqual(["member", "org", "team"])
	})
})
