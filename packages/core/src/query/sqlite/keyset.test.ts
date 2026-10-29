import type { SQL } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { countLiteral, integerLiteral, keysetSQL, orderByKeys, orderSQL } from "./keyset.ts"

const post = sqliteTable("post", { id: text("id").primaryKey(), score: integer("score"), title: text("title") })

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()
const compile = (built: SQL) => dialect.sqlToQuery(built)

const tiebreak = { column: post.id, direction: "desc" as const }

describe("orderSQL and orderByKeys", () => {
	it("spells out null placement for every key and ends with the tiebreak", () => {
		expect(compile(orderSQL({ column: post.score, direction: "asc" })).sql).toBe('"post"."score" ASC NULLS LAST')
		expect(compile(orderSQL({ column: post.score, direction: "asc", nulls: "first" })).sql).toBe(
			'"post"."score" ASC NULLS FIRST',
		)
		const order = orderByKeys([{ column: post.title, direction: "desc" }], tiebreak)
		expect(order.map((part) => compile(part).sql)).toEqual([
			'"post"."title" DESC NULLS FIRST',
			'"post"."id" DESC NULLS FIRST',
		])
	})
})

describe("keysetSQL", () => {
	it("is the tiebreak alone when the order has no other key, in either direction", () => {
		expect(compile(keysetSQL({ id: "p_5", keys: [], tiebreak, values: [] }))).toEqual({
			params: ["p_5"],
			sql: '"post"."id" < ?',
		})
		expect(
			compile(keysetSQL({ id: "p_5", keys: [], tiebreak: { ...tiebreak, direction: "asc" }, values: [] })).sql,
		).toBe('"post"."id" > ?')
	})

	it("expands one branch per key, each after the equal prefix", () => {
		const after = compile(
			keysetSQL({
				id: "p_5",
				keys: [{ column: post.score, direction: "asc", nulls: "first" }],
				tiebreak,
				values: [3],
			}),
		)
		expect(after.sql).toBe('(("post"."score" > ?) or ((("post"."score" = ?) and ("post"."id" < ?))))')
		expect(after.params).toEqual([3, 3, "p_5"])
	})
})

describe("keysetSQL — null placement", () => {
	it("reads rows after a null: non-null values follow only when nulls sort first", () => {
		const first = compile(
			keysetSQL({
				id: "p_5",
				keys: [{ column: post.score, direction: "asc", nulls: "first" }],
				tiebreak,
				values: [null],
			}),
		)
		expect(first.sql).toBe('((("post"."score" is not null)) or (((("post"."score" is null)) and ("post"."id" < ?))))')
		const last = compile(
			keysetSQL({
				id: "p_5",
				keys: [{ column: post.score, direction: "asc", nulls: "last" }],
				tiebreak,
				values: [null],
			}),
		)
		expect(last.sql).toMatch(/^\(+"post"\."score" is null\)+ and \("post"\."id" < \?\)\)$/)
	})

	it("carries the equal prefix of every earlier key into a later key's branch", () => {
		const keys = [
			{ column: post.title, direction: "asc" as const, nulls: "first" as const },
			{ column: post.score, direction: "asc" as const, nulls: "first" as const },
		]
		const after = compile(keysetSQL({ id: "p_5", keys, tiebreak, values: ["a", 3] }))
		expect(after.params).toEqual(["a", "a", 3, "a", 3, "p_5"])
		expect(after.sql.match(/ or /g)).toHaveLength(2)
	})

	it("lets nulls follow a value when they sort last", () => {
		const after = compile(
			keysetSQL({
				id: "p_5",
				keys: [{ column: post.score, direction: "desc", nulls: "last" }],
				tiebreak,
				values: [3],
			}),
		)
		expect(after.sql).toBe(
			'(((("post"."score" < ?) or (("post"."score" is null)))) or ((("post"."score" = ?) and ("post"."id" < ?))))',
		)
	})
})

describe("countLiteral", () => {
	it("writes a count as digits, and refuses anything but a non-negative safe integer", () => {
		expect(new SQLiteDialect().sqlToQuery(countLiteral(42))).toEqual({ params: [], sql: "42" })
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])
			expect(() => countLiteral(bad)).toThrow(RangeError)
	})
})

describe("integerLiteral", () => {
	it("writes an integer past 2^53 as its exact digits, and refuses anything but an integer", () => {
		const sqlite = new SQLiteDialect()
		expect(sqlite.sqlToQuery(integerLiteral(2 ** 60))).toEqual({ params: [], sql: "1152921504606846976" })
		expect(sqlite.sqlToQuery(integerLiteral(-(2 ** 60))).sql).toBe("-1152921504606846976")
		for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => integerLiteral(bad)).toThrow(RangeError)
	})
})
