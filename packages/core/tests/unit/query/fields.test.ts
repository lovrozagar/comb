import { describe, expect, it } from "vitest"
import {
	buildColumns,
	buildRelationColumns,
	filterBySelect,
	getEntityColumns,
	getRelationSelection,
	hasScalarsRequested,
	parseSelect,
} from "../../../src/query/fields.ts"

describe("parseSelect", () => {
	/* Empty + null handling (4) */

	it("returns null for undefined", () => {
		expect(parseSelect(undefined)).toBeNull()
	})

	it("returns null for empty string", () => {
		expect(parseSelect("")).toBeNull()
	})

	it("returns null for whitespace-only", () => {
		expect(parseSelect("   ")).toBeNull()
	})

	it("returns null for string of commas only", () => {
		expect(parseSelect(",,,")).toBeNull()
	})

	/* Scalars (3) */

	it("parses single scalar", () => {
		const result = parseSelect("id")
		expect(result?.root.scalars).toEqual(["id"])
		expect(result?.root.relations.size).toBe(0)
	})

	it("parses comma-separated scalars", () => {
		const result = parseSelect("id,name,email")
		expect(result?.root.scalars).toEqual(["id", "name", "email"])
	})

	it("deduplicates scalars", () => {
		const result = parseSelect("id,id,name,id")
		expect(result?.root.scalars).toEqual(["id", "name"])
	})

	/* Wildcard (2) */

	it("parses top-level wildcard", () => {
		const result = parseSelect("*")
		expect(result?.root.scalars).toEqual(["*"])
		expect(result?.root.relations.size).toBe(0)
	})

	it("parses wildcard mixed with scalars", () => {
		const result = parseSelect("*,name")
		expect(result?.root.scalars).toEqual(["*", "name"])
	})

	/* Single relation, explicit fields (3) */

	it("parses relation with one field", () => {
		const result = parseSelect("author(name)")
		expect(result?.root.scalars).toEqual([])
		expect(result?.root.relations.get("author")?.scalars).toEqual(["name"])
		expect(result?.root.relations.get("author")?.relations.size).toBe(0)
	})

	it("parses relation with multiple fields", () => {
		const result = parseSelect("author(id,name)")
		expect(result?.root.relations.get("author")?.scalars).toEqual(["id", "name"])
	})

	it("parses scalar then relation", () => {
		const result = parseSelect("id,author(name)")
		expect(result?.root.scalars).toEqual(["id"])
		expect(result?.root.relations.get("author")?.scalars).toEqual(["name"])
	})

	/* Single relation, wildcard inside (2) */

	it("parses relation with explicit wildcard", () => {
		const result = parseSelect("author(*)")
		expect(result?.root.relations.get("author")?.scalars).toEqual(["*"])
		expect(result?.root.relations.get("author")?.relations.size).toBe(0)
	})

	it("relation with no fields is rejected (empty parens returns null on that relation)", () => {
		const result = parseSelect("author()")
		expect(result?.root.relations.size).toBe(0)
	})

	/* Nested relations (3) */

	it("parses two-level nested relation", () => {
		const result = parseSelect("author(posts(title))")
		expect(result?.root.relations.get("author")?.relations.get("posts")?.scalars).toEqual(["title"])
	})

	it("parses mixed scalar + nested relation", () => {
		const result = parseSelect("author(id,posts(title))")
		expect(result?.root.relations.get("author")?.scalars).toEqual(["id"])
		expect(result?.root.relations.get("author")?.relations.get("posts")?.scalars).toEqual(["title"])
	})

	it("parses deeply nested (3 levels)", () => {
		const result = parseSelect("a(b(c(d)))")
		expect(result?.root.relations.get("a")?.relations.get("b")?.relations.get("c")?.scalars).toEqual(["d"])
	})

	/* Nested wildcards (2) */

	it("nested relation with wildcard inside", () => {
		const result = parseSelect("author(posts(*))")
		expect(result?.root.relations.get("author")?.relations.get("posts")?.scalars).toEqual(["*"])
	})

	it("scalar + nested relation with wildcard", () => {
		const result = parseSelect("id,author(posts(*))")
		expect(result?.root.scalars).toEqual(["id"])
		expect(result?.root.relations.get("author")?.relations.get("posts")?.scalars).toEqual(["*"])
	})

	/* Computed fields (@ prefix) (3) */

	it("parses @ computed field at top level", () => {
		const result = parseSelect("id,@totalPrice")
		expect(result?.root.scalars).toEqual(["id", "@totalPrice"])
	})

	it("parses @ computed field inside relation embed", () => {
		const result = parseSelect("author(id,@bio)")
		expect(result?.root.relations.get("author")?.scalars).toEqual(["id", "@bio"])
	})

	it("@ prefix before relation is a literal scalar, not a relation", () => {
		const result = parseSelect("@computed")
		expect(result?.root.scalars).toEqual(["@computed"])
		expect(result?.root.relations.size).toBe(0)
	})

	/* Whitespace + trailing commas (2) */

	it("tolerates whitespace around names + commas", () => {
		const result = parseSelect(" id , name , author ( id , name ) ")
		expect(result?.root.scalars).toEqual(["id", "name"])
		expect(result?.root.relations.get("author")?.scalars).toEqual(["id", "name"])
	})

	it("skips empty comma parts", () => {
		const result = parseSelect(",id,,name,")
		expect(result?.root.scalars).toEqual(["id", "name"])
	})

	/* Negative cases — clean break from old grammar (4) */

	it("treats ~ prefix as literal character, NOT relation", () => {
		const result = parseSelect("~author")
		expect(result?.root.scalars).toEqual(["~author"])
		expect(result?.root.relations.size).toBe(0)
	})

	it("treats dot-path as literal character, NOT nesting", () => {
		const result = parseSelect("author.name")
		expect(result?.root.scalars).toEqual(["author.name"])
		expect(result?.root.relations.size).toBe(0)
	})

	it("bare relation name without parens is a scalar", () => {
		const result = parseSelect("author")
		expect(result?.root.scalars).toEqual(["author"])
		expect(result?.root.relations.size).toBe(0)
	})

	it("unmatched open paren is tolerated — treat up to end-of-input as relation body", () => {
		const result = parseSelect("author(id,name")
		expect(result?.root.relations.get("author")?.scalars).toEqual(["id", "name"])
	})

	/* Malformed / edge cases (3) */

	it("stray close-paren is ignored", () => {
		const result = parseSelect("id),name")
		expect(result?.root.scalars).toEqual(["id", "name"])
	})

	it("empty relation body after trim", () => {
		const result = parseSelect("author(   )")
		expect(result?.root.relations.size).toBe(0)
	})

	it("relation name with digits is valid", () => {
		const result = parseSelect("author1(name)")
		expect(result?.root.relations.get("author1")?.scalars).toEqual(["name"])
	})
})

describe("buildColumns", () => {
	it("builds column map from requested scalars", () => {
		const result = buildColumns(["id", "name"], { email: true, id: true, name: true })
		expect(result).toEqual({ id: true, name: true })
	})

	it("returns undefined for empty scalars", () => {
		expect(buildColumns([], { id: true })).toBeUndefined()
	})

	it("ignores unknown scalars", () => {
		const result = buildColumns(["id", "unknown"], { id: true })
		expect(result).toEqual({ id: true })
	})
})

describe("getRelationSelection", () => {
	it("returns null when fields is null (include all)", () => {
		expect(getRelationSelection(null, "author")).toBeNull()
	})

	it("returns undefined when relation not requested", () => {
		const fields = parseSelect("id,name")
		expect(getRelationSelection(fields, "author")).toBeUndefined()
	})

	it("returns selection for requested relation", () => {
		const fields = parseSelect("author(id,name)")
		const selection = getRelationSelection(fields, "author")
		expect(selection?.scalars).toEqual(["id", "name"])
	})
})

describe("buildRelationColumns", () => {
	it("returns undefined when selection is null (all fields)", () => {
		expect(buildRelationColumns(null, { id: true })).toBeUndefined()
	})

	it("builds columns from nested selection", () => {
		const fields = parseSelect("author(id,name)")
		const selection = fields?.root.relations.get("author")
		if (selection) {
			const result = buildRelationColumns(selection, { email: true, id: true, name: true })
			expect(result).toEqual({ id: true, name: true })
		}
	})
})

describe("hasScalarsRequested", () => {
	it("returns true when fields is null", () => {
		expect(hasScalarsRequested(null, ["id"])).toBe(true)
	})

	it("returns true when scalar overlap", () => {
		const fields = parseSelect("id,name")
		expect(hasScalarsRequested(fields, ["id", "email"])).toBe(true)
	})

	it("returns false when no overlap", () => {
		const fields = parseSelect("author(*)")
		expect(hasScalarsRequested(fields, ["id"])).toBe(false)
	})
})

describe("getEntityColumns", () => {
	it("returns undefined when fields is null", () => {
		expect(getEntityColumns(null, { id: true })).toBeUndefined()
	})

	it("builds columns from root scalars", () => {
		const fields = parseSelect("id,name")
		expect(getEntityColumns(fields, { email: true, id: true, name: true })).toEqual({
			id: true,
			name: true,
		})
	})
})

describe("filterBySelect", () => {
	it("filters data by scalar fields", () => {
		const fields = parseSelect("id,name")
		if (!fields) throw new Error("expected fields")
		const data = { email: "a@b.com", id: "1", name: "test" }
		expect(filterBySelect(data, fields)).toEqual({ id: "1", name: "test" })
	})

	it("filters nested relation data", () => {
		const fields = parseSelect("id,author(name)")
		if (!fields) throw new Error("expected fields")
		const data = { author: { email: "a@b.com", id: "2", name: "Bob" }, id: "1" }
		expect(filterBySelect(data, fields)).toEqual({
			author: { name: "Bob" },
			id: "1",
		})
	})

	it("preserves null relation", () => {
		const fields = parseSelect("id,author(name)")
		if (!fields) throw new Error("expected fields")
		const data = { author: null, id: "1" }
		expect(filterBySelect(data, fields)).toEqual({ author: null, id: "1" })
	})

	it("passes through relation when selection has wildcard (all)", () => {
		const fields = parseSelect("id,author(*)")
		if (!fields) throw new Error("expected fields")
		const data = { author: { email: "a@b.com", name: "Bob" }, id: "1" }
		const result = filterBySelect(data, fields)
		expect(result.author).toEqual({ email: "a@b.com", name: "Bob" })
	})

	it("filters array relations", () => {
		const fields = parseSelect("id,tags(name)")
		if (!fields) throw new Error("expected fields")
		const data = {
			id: "1",
			tags: [
				{ id: "t1", name: "tag1" },
				{ id: "t2", name: "tag2" },
			],
		}
		expect(filterBySelect(data, fields)).toEqual({
			id: "1",
			tags: [{ name: "tag1" }, { name: "tag2" }],
		})
	})
})

describe("parseSelect — repeated relations merge", () => {
	it("unions the fields when the same relation appears twice", () => {
		const parsed = parseSelect("author(name),author(email)")
		const author = parsed?.root.relations.get("author")
		expect(author?.scalars.sort()).toEqual(["email", "name"])
	})

	it("does not duplicate a field named in both occurrences", () => {
		const parsed = parseSelect("author(name),author(name,email)")
		const author = parsed?.root.relations.get("author")
		expect(author?.scalars.filter((s) => s === "name")).toHaveLength(1)
	})

	it("merges nested relations recursively", () => {
		const parsed = parseSelect("author(org(id)),author(org(name))")
		const org = parsed?.root.relations.get("author")?.relations.get("org")
		expect(org?.scalars.sort()).toEqual(["id", "name"])
	})
})

describe("filterBySelect — nested shapes", () => {
	it("keeps only the selected scalars", () => {
		const parsed = parseSelect("id,title")!
		expect(filterBySelect({ id: "1", secret: "x", title: "t" }, parsed)).toEqual({ id: "1", title: "t" })
	})

	it("passes everything through for a wildcard, minus explicitly selected relations", () => {
		const parsed = parseSelect("*,author(name)")!
		const out = filterBySelect({ author: { extra: 1, name: "a" }, id: "1", title: "t" }, parsed)
		expect(out["id"]).toBe("1")
		expect(out["author"]).toEqual({ name: "a" })
	})

	it("filters each element of a relation array", () => {
		const parsed = parseSelect("id,tags(slug)")!
		const out = filterBySelect(
			{
				id: "1",
				tags: [
					{ extra: 1, slug: "a" },
					{ extra: 2, slug: "b" },
				],
			},
			parsed,
		)
		expect(out["tags"]).toEqual([{ slug: "a" }, { slug: "b" }])
	})

	it("leaves a non-object element of a relation array alone", () => {
		const parsed = parseSelect("id,tags(slug)")!
		const out = filterBySelect({ id: "1", tags: ["raw", null] }, parsed)
		expect(out["tags"]).toEqual(["raw", null])
	})

	it("preserves null and undefined relations verbatim", () => {
		const parsed = parseSelect("id,author(name)")!
		expect(filterBySelect({ author: null, id: "1" }, parsed)["author"]).toBeNull()
		expect(filterBySelect({ author: undefined, id: "1" }, parsed)).toHaveProperty("author", undefined)
	})

	it("passes a relation through untouched under a nested wildcard", () => {
		const parsed = parseSelect("id,author(*)")!
		const out = filterBySelect({ author: { extra: 1, name: "a" }, id: "1" }, parsed)
		expect(out["author"]).toEqual({ extra: 1, name: "a" })
	})

	it("passes a scalar-valued relation through as-is", () => {
		const parsed = parseSelect("id,author(name)")!
		expect(filterBySelect({ author: "just-a-string", id: "1" }, parsed)["author"]).toBe("just-a-string")
	})

	it("skips a selected relation the data does not carry", () => {
		const parsed = parseSelect("id,author(name)")!
		expect(filterBySelect({ id: "1" }, parsed)).toEqual({ id: "1" })
	})

	it("skips a selected scalar the data does not carry", () => {
		const parsed = parseSelect("id,missing")!
		expect(filterBySelect({ id: "1" }, parsed)).toEqual({ id: "1" })
	})
})
