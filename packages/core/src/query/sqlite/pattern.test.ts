import type { SQL } from "drizzle-orm"
import { SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { patternToSQL } from "./pattern.ts"

const post = sqliteTable("post", { title: text("title") })
const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

describe("patternToSQL", () => {
	it("lowers like to a case-sensitive GLOB", () => {
		expect(dialect.sqlToQuery(patternToSQL(post.title, "like", "Ab*"))).toEqual({
			params: ["Ab*"],
			sql: '"post"."title" GLOB ?',
		})
	})

	it("lowers ilike to LIKE with an escape, so % and _ in the value stay literal", () => {
		expect(dialect.sqlToQuery(patternToSQL(post.title, "ilike", "50%_*"))).toEqual({
			params: ["50\\%\\_%"],
			sql: '"post"."title" LIKE ? ESCAPE \'\\\'',
		})
	})

	it("binds a non-string value as its text", () => {
		expect(dialect.sqlToQuery(patternToSQL(post.title, "like", 42)).params).toEqual(["42"])
	})
})
