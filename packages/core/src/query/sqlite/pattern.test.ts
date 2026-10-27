import type { SQL } from "drizzle-orm"
import { SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { patternToSQL } from "./pattern.ts"

const post = sqliteTable("post", { title: text("title") })
const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

const lowered = (operator: "like" | "ilike", value: unknown) =>
	dialect.sqlToQuery(patternToSQL(post.title, operator, value))

describe("patternToSQL: a pattern with a * inside it", () => {
	it("lowers like to a case-sensitive GLOB", () => {
		expect(lowered("like", "A*b")).toEqual({ params: ["A*b"], sql: '"post"."title" GLOB ?' })
	})

	it("lowers ilike to LIKE with an escape, so % and _ in the value stay literal", () => {
		expect(lowered("ilike", "50%*_x")).toEqual({
			params: ["50\\%%\\_x"],
			sql: '"post"."title" LIKE ? ESCAPE \'\\\'',
		})
	})
})

/* U21: a value whose only * are at its ends is a fixed text, found without a pattern D1 caps */
describe("patternToSQL: a fixed text", () => {
	it("finds it anywhere, at the start, at the end, or as the whole value, with no pattern", () => {
		expect(lowered("like", "*b%c*")).toEqual({ params: ["b%c"], sql: 'instr("post"."title", ?) > 0' })
		expect(lowered("like", "Ab*")).toEqual({ params: ["Ab", "Ab"], sql: 'substr("post"."title", 1, length(?)) = ?' })
		expect(lowered("like", "**_c")).toEqual({ params: ["_c", "_c"], sql: 'substr("post"."title", -length(?)) = ?' })
		expect(lowered("like", "Ab")).toEqual({ params: ["Ab"], sql: '"post"."title" = ? COLLATE BINARY' })
		expect(lowered("like", "")).toEqual({ params: [""], sql: '"post"."title" = ? COLLATE BINARY' })
	})

	it("folds both sides through lower() for ilike, and takes stars alone for any text", () => {
		expect(lowered("ilike", "*AB*")).toEqual({ params: ["AB"], sql: 'instr(lower("post"."title"), lower(?)) > 0' })
		expect(lowered("ilike", "**")).toEqual({ params: [], sql: '"post"."title" IS NOT NULL' })
	})

	it("binds a non-string value as its text", () => {
		expect(lowered("like", 42).params).toEqual(["42"])
	})
})
