import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import {
	buildScalarJsonParts,
	jsonBool,
	jsonCol,
	jsonColAs,
	jsonNullable,
	SQL_SORT_DIR,
} from "../../../../src/query/sqlite/sql.ts"

const post = sqliteTable("post", {
	id: text("id").primaryKey(),
	is_public: integer("is_public", { mode: "boolean" }),
	settings_json: text("settings_json", { mode: "json" }),
	title: text("title"),
	view_count: integer("view_count"),
})

describe("jsonCol", () => {
	it("keys the JSON entry by the database column name", () => {
		expect(jsonCol(post.title, "p")).toBe("'title', p.title")
	})
})

describe("jsonColAs", () => {
	it("keys by the API name while reading the database column", () => {
		expect(jsonColAs("viewCount", post.view_count, "p")).toBe("'viewCount', p.view_count")
	})
})

describe("jsonBool", () => {
	it("maps SQLite's 0/1 storage onto real JSON booleans", () => {
		expect(jsonBool(post.is_public, "p")).toBe(
			"'is_public', CASE WHEN p.is_public = 1 THEN json('true') ELSE json('false') END",
		)
	})
})

describe("jsonNullable", () => {
	it("wraps in json() but preserves NULL rather than emitting json(NULL)", () => {
		expect(jsonNullable(post.settings_json, "p")).toBe(
			"'settings_json', CASE WHEN p.settings_json IS NOT NULL THEN json(p.settings_json) ELSE NULL END",
		)
	})
})

describe("buildScalarJsonParts", () => {
	const defs = [
		{ always: true, api: "id", col: post.id },
		{ api: "title", col: post.title },
		{ api: "viewCount", col: post.view_count },
		{ api: "is_public", col: post.is_public, type: "bool" as const },
		{ api: "settings_json", col: post.settings_json, type: "json" as const },
	]

	it("includes everything when includeAll is set", () => {
		const parts = buildScalarJsonParts(defs, { alias: "p", cols: null, includeAll: true })
		expect(parts).toHaveLength(5)
	})

	it("includes only requested columns, plus the always-on ones", () => {
		const parts = buildScalarJsonParts(defs, { alias: "p", cols: { title: true }, includeAll: false })
		expect(parts).toEqual(["'id', p.id", "'title', p.title"])
	})

	it("treats a false entry in cols as not requested", () => {
		const parts = buildScalarJsonParts(defs, { alias: "p", cols: { title: false }, includeAll: false })
		expect(parts).toEqual(["'id', p.id"])
	})

	it("emits nothing but the always-on columns when cols is null", () => {
		const parts = buildScalarJsonParts(defs, { alias: "p", cols: null, includeAll: false })
		expect(parts).toEqual(["'id', p.id"])
	})

	it("routes each def to the helper its type implies", () => {
		const parts = buildScalarJsonParts(defs, { alias: "p", cols: null, includeAll: true })

		expect(parts).toContain(jsonCol(post.title, "p"))
		/* api name differs from the column, so it must be aliased */
		expect(parts).toContain(jsonColAs("viewCount", post.view_count, "p"))
		expect(parts).toContain(jsonBool(post.is_public, "p"))
		expect(parts).toContain(jsonNullable(post.settings_json, "p"))
	})

	it("returns an empty list for no defs", () => {
		expect(buildScalarJsonParts([], { alias: "p", cols: null, includeAll: true })).toEqual([])
	})
})

describe("SQL_SORT_DIR", () => {
	it("maps every parser direction to its SQL keyword", () => {
		expect(SQL_SORT_DIR.asc).toBe("ASC")
		expect(SQL_SORT_DIR.desc).toBe("DESC")
	})
})
