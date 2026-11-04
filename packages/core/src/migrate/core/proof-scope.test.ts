import { describe, expect, it, vi } from "vitest"
import { verdictOf } from "../__fixtures__/copy-verdict.ts"
import { libsqlConnection } from "../__fixtures__/libsql-connection.ts"
import { scopeCorpus } from "../__fixtures__/scope-corpus.ts"
import { notEngineTables } from "./engine-tables.ts"
import { copyScript, creatable, jsonColumns, type LiveObject, liveObjects, scriptOf } from "./proof-copy.ts"
import { observable } from "./proof-scope.ts"

vi.mock("bun:sqlite", () => import("../__fixtures__/bun-sqlite-node.ts"))

/** The live objects a database `schema` made holds, as check reads them */
async function liveOf(schema: string): Promise<LiveObject[]> {
	const live = libsqlConnection()
	try {
		await live.client.executeMultiple(schema)
		return creatable(await liveObjects(live, notEngineTables(live)))
	} finally {
		await live.close()
	}
}

/** SQLite's answer to `file` on the scoped copy and on the whole schema's copy */
async function verdicts(schema: string, file: string): Promise<{ scoped: string; whole: string }> {
	const objects = await liveOf(schema)
	const files = [{ sql: file }]
	return {
		scoped: verdictOf(await copyScript(objects, files, "d1_migrations"), file),
		whole: verdictOf(await scriptOf(objects, { json: jsonColumns(files), variant: 0 }), file),
	}
}

/** A live table */
const table = (name: string, sql: string): LiveObject => ({ name, sql, table: name, type: "table" })

/* 8.5 of plan 21, ruled 23:35Z: "the closure is enough" is a test, not an argument */
describe("the D1 proof's scoped copy answers every corpus file as the whole schema's copy does (8.5)", () => {
	const corpus = scopeCorpus()

	it.each(corpus.map((each) => [each.label, each] as const))("%s", async (_, { file, schema }) => {
		const { scoped, whole } = await verdicts(schema, file)
		expect(scoped).toBe(whole)
	})

	it("holds files the whole schema refuses, so an equal verdict is not one that passes everything", async () => {
		const refused = []
		for (const { file, schema } of corpus) if ((await verdicts(schema, file)).whole !== "passes") refused.push(file)
		expect(refused.length).toBeGreaterThanOrEqual(20)
	}, 60_000)
})

describe("observable: what the scoped copy creates and seeds", () => {
	it("reads a shadow table's name as its virtual table's, and a key to a table the schema lacks as none", () => {
		const objects = [
			table("docs", "CREATE VIRTUAL TABLE docs USING fts5 (body)"),
			table("box", "CREATE VIRTUAL TABLE box USING no_such_module (x)"),
			table("orphan", "CREATE TABLE orphan (id INTEGER PRIMARY KEY, p INTEGER REFERENCES gone (id))"),
		]
		const scope = observable(objects, [{ sql: "DELETE FROM docs_data; UPDATE orphan SET p = NULL;" }], "h")
		expect(scope.objects.map(({ name }) => name)).toEqual(["docs", "orphan"])
		expect([...scope.seeded].toSorted()).toEqual(["docs", "orphan"])
	})

	it("seeds what a file writes, its descendants and every ancestor of both, and no ancestor's other child", () => {
		const objects = [
			table("Org", "CREATE TABLE Org (id INTEGER PRIMARY KEY, gone INTEGER REFERENCES elsewhere (id))"),
			table("team", 'CREATE TABLE team (id INTEGER PRIMARY KEY, org INTEGER REFERENCES "ORG" (id))'),
			table("member", "CREATE TABLE member (id INTEGER PRIMARY KEY, team INTEGER REFERENCES team (id))"),
			table("sibling", "CREATE TABLE sibling (id INTEGER PRIMARY KEY, org INTEGER REFERENCES org (id))"),
		]
		const scope = observable(objects, [{ sql: "UPDATE team SET id = id;" }], "h")
		expect([...scope.seeded].toSorted()).toEqual(["member", "org", "team"])
		expect(scope.objects.map(({ name }) => name)).toEqual(["Org", "team", "member"])
	})

	it("seeds the history table a pending file never names, and no table it does not name", () => {
		const objects = [
			table("d1_migrations", "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT)"),
			table("other", "CREATE TABLE other (x)"),
		]
		expect([...observable(objects, [{ sql: "SELECT 1;" }], "D1_Migrations").seeded]).toEqual(["d1_migrations"])
	})
})
