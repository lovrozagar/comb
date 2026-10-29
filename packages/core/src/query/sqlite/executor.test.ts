/**
 * conditionToSQL / filterToSQL — the lowering of a parsed,
 * user-supplied filter into SQL. Public API, and the surface where a filter
 * value could reach the query text, so the bindings are asserted, not just the
 * shape.
 */
import type { SQL } from "drizzle-orm"
import { integer, numeric, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { parseFilter } from "../filter.ts"
import { CombError } from "../../error.ts"
import { conditionToSQL, filterToSQL } from "./executor.ts"
import type { FilterAST, FilterCondition } from "../types.ts"

const post = sqliteTable("post", {
	created_at: integer("created_at"),
	id: text("id").primaryKey(),
	status: text("status"),
	title: text("title"),
	view_count: integer("view_count"),
})

const dialect = new (SQLiteDialect as unknown as new () => {
	sqlToQuery: (sql: SQL) => { params: unknown[]; sql: string }
})()

const compile = (built: SQL | null) => {
	if (!built) throw new Error("expected SQL, got null")
	return dialect.sqlToQuery(built)
}

const cond = (field: string, operator: string, value: unknown): FilterCondition =>
	({ field, operator, value }) as FilterCondition

const ast = (conditions: FilterCondition[], logic: "and" | "or" = "and"): FilterAST => ({
	root: { conditions, logic, subgroups: [] },
})

describe("conditionToSQL", () => {
	const cases: Array<[string, unknown, string]> = [
		["eq", "draft", "= ?"],
		["ne", "draft", "<> ?"],
		["neq", "draft", "<> ?"],
		["gt", "m", "> ?"],
		["gte", "m", ">= ?"],
		["lt", "m", "< ?"],
		["lte", "m", "<= ?"],
	]

	for (const [operator, value, fragment] of cases) {
		it(`lowers ${operator} to a bound comparison`, () => {
			const { params, sql } = compile(conditionToSQL(cond("status", operator, value), post.status))
			expect(sql.toLowerCase()).toContain(fragment)
			expect(params).toEqual([value])
		})
	}

	it("lowers like with a * inside it to case-sensitive GLOB, keeping * as the wildcard", () => {
		const { params, sql } = compile(conditionToSQL(cond("title", "like", "in*tro?"), post.title))
		expect(sql.toLowerCase()).toContain("glob ?")
		expect(params).toEqual(["in*tro[?]"])
	})

	it("lowers in/nin to bound lists", () => {
		const inSql = compile(conditionToSQL(cond("status", "in", ["draft", "sent"]), post.status))
		expect(inSql.params).toEqual(["draft", "sent"])
		expect(inSql.sql.toLowerCase()).toContain("in (?, ?)")

		const ninSql = compile(conditionToSQL(cond("status", "nin", ["draft"]), post.status))
		expect(ninSql.sql.toLowerCase()).toContain("not in")
	})

	it("lowers ilike with a * inside it to LIKE … ESCAPE (SQLite LIKE ignores ASCII case)", () => {
		const { params, sql } = compile(conditionToSQL(cond("title", "ilike", "In*tro"), post.title))
		expect(sql.toLowerCase()).toContain("like ?")
		expect(sql.toLowerCase()).toContain("escape")
		expect(params).toEqual(["In%tro"])
	})

	it("does not treat name.ilike.% as a match-all wildcard", () => {
		const parsed = parseFilter("name.ilike.%")
		expect(parsed?.root.conditions[0]?.value).toBe("%")
		const { params, sql } = compile(conditionToSQL(parsed!.root.conditions[0]!, post.title))
		/* a value with no * is a fixed text, compared with no pattern (U21) */
		expect(params).toEqual(["%"])
		expect(sql.toLowerCase()).toBe('lower("post"."title") = lower(?) collate binary')
	})
})

describe("conditionToSQL — null checks and rejections", () => {
	it("lowers is.null and is.notnull to null checks with no bindings", () => {
		const isNull = compile(conditionToSQL(cond("status", "is", null), post.status))
		expect(isNull.sql.toLowerCase()).toContain("is null")
		expect(isNull.params).toEqual([])

		const notNull = compile(conditionToSQL(cond("status", "is", "notnull"), post.status))
		expect(notNull.sql.toLowerCase()).toContain("is not null")
		expect(notNull.params).toEqual([])
	})

	it("lowers is.true and is.false on a boolean to an equality", () => {
		expect(compile(conditionToSQL(cond("status", "is", true), post.status)).params).toEqual([true])
		expect(compile(conditionToSQL(cond("status", "is", false), post.status)).params).toEqual([false])
	})

	it("returns null for an is value it does not recognise", () => {
		expect(conditionToSQL(cond("status", "is", "maybe"), post.status)).toBeNull()
	})

	it("returns null for an unknown operator rather than emitting anything", () => {
		expect(conditionToSQL(cond("status", "regex", ".*"), post.status)).toBeNull()
	})

	it("never lets a filter value reach the query text", () => {
		const hostile = "'; DROP TABLE post; --"
		const { params, sql } = compile(conditionToSQL(cond("title", "eq", hostile), post.title))
		expect(sql).not.toContain("DROP TABLE")
		expect(params).toEqual([hostile])
	})
})

describe("filterToSQL", () => {
	const config = { mainTable: post }

	it("returns null for a null AST", () => {
		expect(filterToSQL(null, config)).toBeNull()
	})

	it("throws for a field it cannot resolve rather than dropping it (Q-H3)", () => {
		expect(() => filterToSQL(ast([cond("nope", "eq", 1)]), config)).toThrow(CombError)
	})

	it("reads a group with no conditions as the identity of its logic", () => {
		expect(compile(filterToSQL(ast([]), config)).sql).toBe("1")
		expect(compile(filterToSQL({ root: { conditions: [], logic: "or", subgroups: [] } }, config)).sql).toBe("0")
		expect(filterToSQL(null, config)).toBeNull()
	})

	it("passes a single condition through without wrapping it", () => {
		const { params, sql } = compile(filterToSQL(ast([cond("status", "eq", "draft")]), config))
		expect(sql.toLowerCase()).not.toContain(" and ")
		expect(params).toEqual(["draft"])
	})

	it("joins sibling conditions with and", () => {
		const built = filterToSQL(ast([cond("status", "eq", "draft"), cond("view_count", "gt", 5)]), config)
		const { params, sql } = compile(built)
		expect(sql.toLowerCase()).toContain(" and ")
		expect(params).toEqual(["draft", 5])
	})

	it("joins sibling conditions with or when the group says so", () => {
		const built = filterToSQL(ast([cond("status", "eq", "draft"), cond("status", "eq", "sent")], "or"), config)
		expect(compile(built).sql.toLowerCase()).toContain(" or ")
	})

	it("throws when one condition of several cannot be resolved, instead of keeping the rest", () => {
		expect(() => filterToSQL(ast([cond("status", "eq", "draft"), cond("secret", "eq", "x")]), config)).toThrow(
			CombError,
		)
	})
})

describe("filterToSQL — prototype names, subgroups and computed fields", () => {
	const config = { mainTable: post }

	it("does not resolve a field through the prototype chain (Q-L3)", () => {
		expect(() => filterToSQL(ast([cond("toString", "is", null)]), config)).toThrow(CombError)
		expect(() => filterToSQL(ast([cond("@constructor", "eq", 1)]), { computedFilters: {}, mainTable: post })).toThrow(
			CombError,
		)
	})

	it("recurses into subgroups", () => {
		const nested: FilterAST = {
			root: {
				conditions: [cond("status", "eq", "draft")],
				logic: "and",
				subgroups: [
					{ conditions: [cond("view_count", "lt", 5), cond("view_count", "gt", 1)], logic: "or", subgroups: [] },
				],
			},
		}
		const { params, sql } = compile(filterToSQL(nested, config))
		expect(sql.toLowerCase()).toContain(" and ")
		expect(sql.toLowerCase()).toContain(" or ")
		expect(params).toEqual(["draft", 5, 1])
	})

	it("routes a computed field to its resolver", () => {
		const built = filterToSQL(ast([cond("@popular", "eq", true)]), {
			computedFilters: { "@popular": () => post.view_count.getSQL() },
			mainTable: post,
		})
		expect(built).not.toBeNull()
	})

	it("throws for a computed field with no resolver, or one that declines the operator", () => {
		expect(() => filterToSQL(ast([cond("@popular", "eq", true)]), config)).toThrow(CombError)
		expect(() =>
			filterToSQL(ast([cond("@popular", "eq", true)]), {
				computedFilters: { "@popular": () => null },
				mainTable: post,
			}),
		).toThrow(CombError)
	})
})

/* C13 of the 0.14.1 review: a member of the JSON array the column holds; the live rows are tests/integration/libsql/iso-date-filter.test.ts */
describe("filterToSQL — contains", () => {
	it("lowers contains to a json_each lookup, the value bound", () => {
		const where = filterToSQL(ast([cond("title", "contains", "x")]), { mainTable: post })
		const query = new SQLiteDialect().sqlToQuery(where as SQL)
		expect(query.sql).toBe('EXISTS (SELECT 1 FROM json_each("post"."title") WHERE value = ?)')
		expect(query.params).toEqual(["x"])
	})
})

describe("filterToSQL — relation filters", () => {
	/* post -> post_tag -> tag: filtering a post by a property of a tag it carries */
	const tag = sqliteTable("tag", { id: text("id").primaryKey(), slug: text("slug") })
	const postTag = sqliteTable("post_tag", { post_id: text("post_id"), tag_id: text("tag_id") })

	const relations = {
		tags: { target: tag, targetKey: "id", through: postTag, throughSourceKey: "post_id", throughTargetKey: "tag_id" },
	}

	const config = { mainTable: post, relations }

	it("lowers a relation filter to an EXISTS subquery joining on the keys it names", () => {
		const built = filterToSQL(ast([cond("tags.slug", "eq", "release")]), config)
		const { params, sql } = compile(built)
		expect(sql.replace(/\s+/g, " ")).toBe(
			'EXISTS ( SELECT 1 FROM "post_tag" AS "comb_rel_through" INNER JOIN "tag" AS "comb_rel_target" ON "comb_rel_target"."id" = "comb_rel_through"."tag_id" WHERE "comb_rel_through"."post_id" = "post"."id" AND "comb_rel_target"."slug" = ? )',
		)
		expect(params).toEqual(["release"])
	})
})

describe("filterToSQL — relation filters: keys and refusals", () => {
	const tag = sqliteTable("tag", { id: text("id").primaryKey(), slug: text("slug") })
	const postTag = sqliteTable("post_tag", { post_id: text("post_id"), tag_id: text("tag_id") })
	const relations = {
		tags: { target: tag, targetKey: "id", through: postTag, throughSourceKey: "post_id", throughTargetKey: "tag_id" },
	}
	const config = { mainTable: post, relations }

	it("joins on the main table's named key, and refuses a main table without one", () => {
		const bySlug = { tags: { ...relations.tags, sourceKey: "status" } }
		const { sql } = compile(filterToSQL(ast([cond("tags.slug", "eq", "x")]), { mainTable: post, relations: bySlug }))
		expect(sql).toContain('"comb_rel_through"."post_id" = "post"."status"')
		const keyless = sqliteTable("keyless", { a: text("a"), b: text("b") })
		expect(() => filterToSQL(ast([cond("tags.slug", "eq", "x")]), { mainTable: keyless, relations })).toThrow(CombError)
	})

	it("binds the relation filter value rather than inlining it", () => {
		const built = filterToSQL(ast([cond("tags.slug", "eq", "'; DROP TABLE tag; --")]), config)
		const { params, sql } = compile(built)
		expect(sql).not.toContain("DROP TABLE")
		expect(params).toEqual(["'; DROP TABLE tag; --"])
	})

	it("combines a relation filter with a plain column filter", () => {
		const built = filterToSQL(ast([cond("status", "eq", "draft"), cond("tags.slug", "eq", "release")]), config)
		const { params, sql } = compile(built)
		expect(sql.toLowerCase()).toContain(" and ")
		expect(params).toEqual(["draft", "release"])
	})

	it("throws for a relation the config does not declare", () => {
		expect(() => filterToSQL(ast([cond("authors.name", "eq", "x")]), config)).toThrow(CombError)
	})

	it("throws for a field the related table does not have", () => {
		expect(() => filterToSQL(ast([cond("tags.nonexistent", "eq", "x")]), config)).toThrow(CombError)
	})

	it("throws for a relation filter whose operator does not lower", () => {
		expect(() => filterToSQL(ast([cond("tags.slug", "regex", ".*")]), config)).toThrow(CombError)
	})

	it("throws for a bare relation name with no field", () => {
		expect(() => filterToSQL(ast([cond("tags.", "eq", "x")]), config)).toThrow(CombError)
	})

	it("supports list operators across the relation", () => {
		const built = filterToSQL(ast([cond("tags.slug", "in", ["a", "b"])]), config)
		const { params, sql } = compile(built)
		expect(sql.toLowerCase()).toContain("in (?, ?)")
		expect(params).toEqual(["a", "b"])
	})
})

describe("conditionToSQL — values and the column's type (B4)", () => {
	const typed = sqliteTable("typed", { at: integer("at", { mode: "timestamp" }), name: text("name") })

	it("binds a date field's milliseconds as a Date on a date column, which drizzle writes in seconds here", () => {
		expect(compile(conditionToSQL(cond("at", "gt", 2000), typed.at)).params).toEqual([2])
	})

	/* U25: each in/nin member of a date field is bound as eq's value is, in the column's own unit */
	it("binds each in and nin member as the column's unit, on milliseconds and on seconds", () => {
		const ms = sqliteTable("ms", { at: integer("at", { mode: "timestamp_ms" }) })
		expect(compile(conditionToSQL(cond("at", "in", [2000, 3500]), ms.at))).toEqual({
			params: [2000, 3500],
			sql: '"ms"."at" in (?, ?)',
		})
		expect(compile(conditionToSQL(cond("at", "nin", [2000]), ms.at)).params).toEqual([2000])
		expect(compile(conditionToSQL(cond("at", "gt", 1500), ms.at)).params).toEqual([1500])
		/* is takes no instant, so its null stays as it is */
		expect(compile(conditionToSQL(cond("at", "is", null), ms.at)).sql).toBe('("ms"."at" is null)')
		/* on seconds a member between two seconds matches no row, as eq's value does, and nin leaves every row with a value */
		expect(compile(conditionToSQL(cond("at", "in", [2000, 3500]), typed.at))).toEqual({
			params: [2],
			sql: '"typed"."at" in (?)',
		})
		expect(compile(conditionToSQL(cond("at", "in", [3500]), typed.at))).toEqual({ params: [], sql: "0" })
		expect(compile(conditionToSQL(cond("at", "nin", [2000, 3500]), typed.at))).toEqual({
			params: [2],
			sql: '"typed"."at" not in (?)',
		})
		expect(compile(conditionToSQL(cond("at", "nin", [3500]), typed.at))).toEqual({
			params: [],
			sql: '("typed"."at" is not null)',
		})
	})

	it("refuses a number, or a list holding one, against a text column", () => {
		expect(conditionToSQL(cond("name", "gt", 5), typed.name)).toBeNull()
		expect(conditionToSQL(cond("name", "in", ["a", 1]), typed.name)).toBeNull()
		expect(conditionToSQL(cond("name", "in", ["a", "b"]), typed.name)).not.toBeNull()
	})
})

describe("conditionToSQL — text and numbers on numeric, date and number columns (U35)", () => {
	/* U35b: drizzle labels numeric() "string numeric", and its NUMERIC affinity compares a number as a number */
	it("lowers a number, or a list of them, on a numeric column", () => {
		const priced = sqliteTable("priced", { amount: numeric("amount") })
		expect(compile(conditionToSQL(cond("amount", "gte", 9.5), priced.amount))?.sql).toBe('"priced"."amount" >= ?')
		expect(conditionToSQL(cond("amount", "in", [2, 10]), priced.amount)).not.toBeNull()
		expect(conditionToSQL(cond("amount", "eq", "10"), priced.amount)).not.toBeNull()
	})

	/* U35: an ISO date field lowers onto a text column only; a date column's mapper takes a Date, and a number column compares text as text */
	it("refuses text, or a list holding it, against a date or a number column, and answers filter_not_wired", () => {
		const counted = sqliteTable("counted", { at: integer("at", { mode: "timestamp" }), n: integer("n") })
		const iso = "2023-11-14T22:13:20Z"
		expect(conditionToSQL(cond("at", "eq", iso), counted.at)).toBeNull()
		expect(conditionToSQL(cond("at", "in", [iso]), counted.at)).toBeNull()
		expect(conditionToSQL(cond("n", "gte", iso), counted.n)).toBeNull()
		expect(conditionToSQL(cond("at", "is", "notnull"), counted.at)).not.toBeNull()
		expect(conditionToSQL(cond("at", "eq", 2000), counted.at)).not.toBeNull()
		const unwired: FilterAST = { root: { conditions: [cond("at", "lt", iso)], logic: "and", subgroups: [] } }
		expect(() => filterToSQL(unwired, { mainTable: counted })).toThrow(
			expect.objectContaining({ errorKey: "filter_not_wired" }),
		)
	})
})
