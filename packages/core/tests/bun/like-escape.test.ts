import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import type { SQL } from "drizzle-orm"
import { SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { parseFilter } from "../../src/query/filter.ts"
import { likePattern } from "../../src/query/like.ts"
import { conditionToSQL } from "../../src/query/sqlite/executor.ts"

const item = sqliteTable("item", {
	name: text("name").notNull(),
})

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

describe("name.like.% against SQLite", () => {
	it("matches the character %, not every row", () => {
		expect(likePattern("%")).toBe("\\%")

		const ast = parseFilter("name.like.%")
		const condition = ast?.root.conditions[0]
		expect(condition?.value).toBe("%")

		const built = conditionToSQL(condition!, item.name)
		expect(built).not.toBeNull()
		const { params, sql } = dialect.sqlToQuery(built!)
		expect(params).toEqual(["\\%"])
		expect(sql.toLowerCase()).toContain("escape")

		const db = new Database(":memory:")
		db.run("CREATE TABLE item (name TEXT NOT NULL)")
		db.run("INSERT INTO item (name) VALUES (?), (?), (?), (?)", ["alice", "bob", "100%", "%"])

		const rows = db.query<{ name: string }, [string]>(`SELECT name FROM item WHERE ${sql}`).all(params[0] as string)
		expect(rows.map((row) => row.name)).toEqual(["%"])
		expect(rows.length).toBeLessThan(4)
	})
})
