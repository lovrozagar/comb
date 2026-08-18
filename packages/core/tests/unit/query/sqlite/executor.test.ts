/**
 * conditionToSQL / filterToSQL / sortToOrderBy — the lowering of a parsed,
 * user-supplied filter into SQL. Public API, and the surface where a filter
 * value could reach the query text, so the bindings are asserted, not just the
 * shape.
 */
import type { SQL } from "drizzle-orm"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { parseFilter } from "../../../../src/query/filter.ts"
import { conditionToSQL, filterToSQL, sortToOrderBy } from "../../../../src/query/sqlite/executor.ts"
import type { FilterAST, FilterCondition, ListQueryCapabilities } from "../../../../src/query/types.ts"

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

function capabilities(overrides: Partial<ListQueryCapabilities> = {}): ListQueryCapabilities {
	return {
		computedFilterFields: {},
		computedSortFields: new Set(),
		filterFields: { created_at: "date", status: "enum", title: "string", view_count: "number" },
		pagination: { defaultLimit: 20, maxLimit: 100 },
		relationFilterFields: {},
		searchFields: new Set(["title"]),
		sortFields: new Set(["created_at", "title"]),
		...overrides,
	}
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
		["gt", 5, "> ?"],
		["gte", 5, ">= ?"],
		["lt", 5, "< ?"],
		["lte", 5, "<= ?"],
	]

	for (const [operator, value, fragment] of cases) {
		it(`lowers ${operator} to a bound comparison`, () => {
			const { params, sql } = compile(conditionToSQL(cond("status", operator, value), post.status))
			expect(sql.toLowerCase()).toContain(fragment)
			expect(params).toEqual([value])
		})
	}

	it("expands * after escaping LIKE specials and binds ESCAPE", () => {
		const { params, sql } = compile(conditionToSQL(cond("title", "like", "*intro*"), post.title))
		expect(sql.toLowerCase()).toContain("like ?")
		expect(sql.toLowerCase()).toContain("escape")
		expect(params).toEqual(["%intro%"])
	})

	it("lowers in/nin to bound lists", () => {
		const inSql = compile(conditionToSQL(cond("status", "in", ["draft", "sent"]), post.status))
		expect(inSql.params).toEqual(["draft", "sent"])
		expect(inSql.sql.toLowerCase()).toContain("in (?, ?)")

		const ninSql = compile(conditionToSQL(cond("status", "nin", ["draft"]), post.status))
		expect(ninSql.sql.toLowerCase()).toContain("not in")
	})

	it("lowers ilike to LIKE … ESCAPE with a case-insensitive collation", () => {
		const { params, sql } = compile(conditionToSQL(cond("title", "ilike", "*Intro*"), post.title))
		expect(sql.toLowerCase()).toContain("like ?")
		expect(sql.toLowerCase()).toContain("escape")
		expect(sql.toLowerCase()).toContain("nocase")
		expect(params).toEqual(["%Intro%"])
	})

	it("does not treat name.like.% as a match-all wildcard", () => {
		const parsed = parseFilter("name.like.%")
		expect(parsed?.root.conditions[0]?.value).toBe("%")
		const { params, sql } = compile(conditionToSQL(parsed!.root.conditions[0]!, post.title))
		expect(params).toEqual(["\\%"])
		expect(sql.toLowerCase()).toContain("escape")
		expect(params[0]).not.toBe("%")
	})

	it("lowers is.null and is.notnull to null checks with no bindings", () => {
		const isNull = compile(conditionToSQL(cond("status", "is", null), post.status))
		expect(isNull.sql.toLowerCase()).toContain("is null")
		expect(isNull.params).toEqual([])

		const notNull = compile(conditionToSQL(cond("status", "is", "notnull"), post.status))
		expect(notNull.sql.toLowerCase()).toContain("is not null")
		expect(notNull.params).toEqual([])
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
	const config = { capabilities: capabilities(), mainTable: post }

	it("returns null for a null AST", () => {
		expect(filterToSQL(null, config)).toBeNull()
	})

	it("returns null when nothing in the group resolved", () => {
		expect(filterToSQL(ast([cond("nope", "eq", 1)]), config)).toBeNull()
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

	it("drops a field the capabilities do not allow, keeping the rest", () => {
		const built = filterToSQL(ast([cond("status", "eq", "draft"), cond("secret", "eq", "x")]), config)
		const { params } = compile(built)
		expect(params).toEqual(["draft"])
	})

	it("drops a declared field that has no column on the table", () => {
		const built = filterToSQL(ast([cond("ghost", "eq", 1)]), {
			capabilities: capabilities({ filterFields: { ghost: "string" } }),
			mainTable: post,
		})
		expect(built).toBeNull()
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
			capabilities: capabilities({ computedFilterFields: { "@popular": "boolean" } }),
			computedFilters: { "@popular": () => post.view_count.getSQL() },
			mainTable: post,
		})
		expect(built).not.toBeNull()
	})

	it("drops a computed field with no resolver rather than guessing", () => {
		const built = filterToSQL(ast([cond("@popular", "eq", true)]), {
			capabilities: capabilities({ computedFilterFields: { "@popular": "boolean" } }),
			mainTable: post,
		})
		expect(built).toBeNull()
	})
})

describe("sortToOrderBy", () => {
	const config = { capabilities: capabilities(), table: post }

	it("returns nothing for no sort fields", () => {
		expect(sortToOrderBy([], config)).toEqual([])
	})

	it("orders by a permitted field in both directions", () => {
		const asc = sortToOrderBy([{ direction: "asc", field: "created_at" }], config)
		expect(compile(asc[0]!).sql.toLowerCase()).toContain("asc")

		const desc = sortToOrderBy([{ direction: "desc", field: "created_at" }], config)
		expect(compile(desc[0]!).sql.toLowerCase()).toContain("desc")
	})

	it("preserves the order the fields were given in", () => {
		const built = sortToOrderBy(
			[
				{ direction: "asc", field: "title" },
				{ direction: "desc", field: "created_at" },
			],
			config,
		)
		expect(built).toHaveLength(2)
		expect(compile(built[0]!).sql).toContain("title")
		expect(compile(built[1]!).sql).toContain("created_at")
	})

	it("drops a field the capabilities do not permit", () => {
		expect(sortToOrderBy([{ direction: "asc", field: "view_count" }], config)).toEqual([])
	})

	it("routes a computed sort to its resolver and drops it when absent", () => {
		const withResolver = sortToOrderBy([{ direction: "asc", field: "@popularity" }], {
			capabilities: capabilities({ computedSortFields: new Set(["@popularity"]) }),
			computedSorts: { "@popularity": () => post.view_count.getSQL() },
			table: post,
		})
		expect(withResolver).toHaveLength(1)

		const without = sortToOrderBy([{ direction: "asc", field: "@popularity" }], {
			capabilities: capabilities({ computedSortFields: new Set(["@popularity"]) }),
			table: post,
		})
		expect(without).toEqual([])
	})
})

describe("filterToSQL — relation filters", () => {
	/* post -> post_tag -> tag: filtering a post by a property of a tag it carries */
	const tag = sqliteTable("tag", { id: text("id").primaryKey(), slug: text("slug") })
	const postTag = sqliteTable("post_tag", { post_id: text("post_id"), tag_id: text("tag_id") })

	const relations = {
		tags: { target: tag, targetKey: "id", through: postTag, throughKey: "post_id" },
	}

	const config = {
		capabilities: capabilities({ relationFilterFields: { "tags.slug": "string" } }),
		mainTable: post,
		relations,
	}

	it("lowers a relation filter to an EXISTS subquery over the join table", () => {
		const built = filterToSQL(ast([cond("tags.slug", "eq", "release")]), config)
		const { params, sql } = compile(built)

		expect(sql.toLowerCase()).toContain("exists")
		expect(sql).toContain("post_tag")
		expect(sql).toContain("tag")
		expect(params).toEqual(["release"])
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

	it("drops a relation the config does not declare", () => {
		expect(filterToSQL(ast([cond("authors.name", "eq", "x")]), config)).toBeNull()
	})

	it("drops a field the related table does not have", () => {
		expect(filterToSQL(ast([cond("tags.nonexistent", "eq", "x")]), config)).toBeNull()
	})

	it("drops a relation filter whose operator does not lower", () => {
		expect(filterToSQL(ast([cond("tags.slug", "regex", ".*")]), config)).toBeNull()
	})

	it("treats a bare relation name with no field as unresolvable", () => {
		expect(filterToSQL(ast([cond("tags.", "eq", "x")]), config)).toBeNull()
	})

	it("supports list operators across the relation", () => {
		const built = filterToSQL(ast([cond("tags.slug", "in", ["a", "b"])]), config)
		const { params, sql } = compile(built)
		expect(sql.toLowerCase()).toContain("in (?, ?)")
		expect(params).toEqual(["a", "b"])
	})
})
