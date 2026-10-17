import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it } from "vitest"
import { type LibsqlHarness, libsqlMemory } from "../support/libsql.ts"

const note = sqliteTable("note", { body: text("body").notNull(), id: integer("id").primaryKey() })

describe("libsql harness", () => {
	let harness: LibsqlHarness | undefined

	afterEach(() => {
		harness?.close()
		harness = undefined
	})

	it("runs drizzle queries on an in-memory database", async () => {
		harness = libsqlMemory()
		await harness.db.run(sql`CREATE TABLE note (id integer PRIMARY KEY, body text NOT NULL)`)
		await harness.db.insert(note).values([
			{ body: "a", id: 1 },
			{ body: "b", id: 2 },
		])
		expect(await harness.db.select().from(note).orderBy(note.id)).toEqual([
			{ body: "a", id: 1 },
			{ body: "b", id: 2 },
		])
	})

	it("gives every harness its own database", async () => {
		harness = libsqlMemory()
		const tables = await harness.client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
		expect(tables.rows).toEqual([])
	})

	it("reports engine errors with SQLite's extended code", async () => {
		harness = libsqlMemory()
		await harness.client.execute("CREATE TABLE u (email text UNIQUE)")
		await harness.client.execute("INSERT INTO u VALUES ('x')")
		await expect(harness.client.execute("INSERT INTO u VALUES ('x')")).rejects.toMatchObject({
			code: "SQLITE_CONSTRAINT",
			extendedCode: "SQLITE_CONSTRAINT_UNIQUE",
			rawCode: 2067,
		})
	})
})
