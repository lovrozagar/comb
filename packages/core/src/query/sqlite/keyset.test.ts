import type { SQL } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { keysetSQL, orderByKeys, orderSQL } from "./keyset.ts"

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
		expect(compile(keysetSQL([], [], tiebreak, "p_5"))).toEqual({ params: ["p_5"], sql: '"post"."id" < ?' })
		expect(compile(keysetSQL([], [], { ...tiebreak, direction: "asc" }, "p_5")).sql).toBe('"post"."id" > ?')
	})

	it("expands one branch per key, each after the equal prefix", () => {
		const after = compile(keysetSQL([{ column: post.score, direction: "asc", nulls: "first" }], [3], tiebreak, "p_5"))
		expect(after.sql).toBe('(("post"."score" > ?) or ((("post"."score" = ?) and ("post"."id" < ?))))')
		expect(after.params).toEqual([3, 3, "p_5"])
	})

	it("reads rows after a null: non-null values follow only when nulls sort first", () => {
		const first = compile(
			keysetSQL([{ column: post.score, direction: "asc", nulls: "first" }], [null], tiebreak, "p_5"),
		)
		expect(first.sql).toBe('((("post"."score" is not null)) or (((("post"."score" is null)) and ("post"."id" < ?))))')
		const last = compile(keysetSQL([{ column: post.score, direction: "asc", nulls: "last" }], [null], tiebreak, "p_5"))
		expect(last.sql).toMatch(/^\(+"post"\."score" is null\)+ and \("post"\."id" < \?\)\)$/)
	})

	it("carries the equal prefix of every earlier key into a later key's branch", () => {
		const keys = [
			{ column: post.title, direction: "asc" as const, nulls: "first" as const },
			{ column: post.score, direction: "asc" as const, nulls: "first" as const },
		]
		const after = compile(keysetSQL(keys, ["a", 3], tiebreak, "p_5"))
		expect(after.params).toEqual(["a", "a", 3, "a", 3, "p_5"])
		expect(after.sql.match(/ or /g)).toHaveLength(2)
	})

	it("lets nulls follow a value when they sort last", () => {
		const after = compile(keysetSQL([{ column: post.score, direction: "desc", nulls: "last" }], [3], tiebreak, "p_5"))
		expect(after.sql).toBe(
			'(((("post"."score" < ?) or (("post"."score" is null)))) or ((("post"."score" = ?) and ("post"."id" < ?))))',
		)
	})
})
