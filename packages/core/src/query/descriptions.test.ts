import { describe, expect, it } from "vitest"
import { filterParamMeta, limitParamMeta, orderParamMeta, searchParamMeta, selectParamMeta } from "./descriptions.ts"
import type { FieldType, FilterOperator } from "./types.ts"
import { FILTER_LIMITS } from "./filter.ts"

const LIMITS = { maxConditions: 20, maxDepth: 3, maxInValues: 50, maxPatternBytes: 50, maxValues: 60 }
const operatorsFor = (type: FieldType): readonly FilterOperator[] => (type === "boolean" ? ["eq", "is"] : ["eq", "in"])

describe("filterParamMeta", () => {
	it("lists every field with its operators and every limit", () => {
		const { description } = filterParamMeta({ active: "boolean", title: "string" }, operatorsFor, LIMITS)
		expect(description).toContain("Fields: active (boolean: eq, is); title (string: eq, in).")
		expect(description).toContain(
			"At most 20 conditions, 3 nested groups, 50 in/nin values per list, 60 values in all, 50 bytes in a like or ilike pattern once escaped, and at most 4608 bytes however a URL or a form encodes it.",
		)
	})

	it("says what is takes, true and false on a boolean included", () => {
		const { description } = filterParamMeta({ active: "boolean" }, operatorsFor, LIMITS)
		expect(description).toContain("`is` takes `null` or `notnull`, and `true` or `false` on a boolean.")
	})

	it("samples one condition per type, a text search and an or() of the first two", () => {
		const fields = { at: "date", n: "number", ok: "boolean", status: "enum", title: "string" } as const
		expect(filterParamMeta(fields, operatorsFor, LIMITS).examples).toEqual([
			"at.gte.1735689600000",
			"title.ilike.*acme*",
			"or(at.gte.1735689600000,n.gte.10)",
		])
		expect(filterParamMeta({ ok: "boolean" }, operatorsFor, LIMITS).examples).toEqual(["ok.eq.true"])
		expect(filterParamMeta({ s: "enum", t: "boolean" }, operatorsFor, LIMITS).examples).toEqual([
			"s.is.notnull",
			"or(s.is.notnull,t.eq.true)",
		])
	})
})

describe("orderParamMeta", () => {
	it("publishes a pattern that admits the sortable keys only, up to the cap", () => {
		const { pattern } = orderParamMeta(["created_at", "a.b"], 2)
		const matches = (order: string) => new RegExp(pattern).test(order)
		expect(matches("created_at.desc,a.b.asc.nullslast")).toBe(true)
		expect(matches("created_at,a.b,created_at")).toBe(false)
		expect(matches("axb")).toBe(false)
	})

	it("gives two examples whether one key or more is sortable", () => {
		expect(orderParamMeta(["a", "b"], 3).examples).toEqual(["a.desc", "b.asc,a.desc"])
		expect(orderParamMeta(["a"], 1)).toMatchObject({
			examples: ["a.desc", "a.asc"],
			pattern: expect.stringContaining("{0,0}"),
		})
		expect(orderParamMeta([], 0).examples).toEqual([".desc", ".asc"])
	})
})

describe("searchParamMeta", () => {
	it("names the searched fields and the term cap", () => {
		expect(searchParamMeta(["name", "email"], 8).description).toBe(
			"Free-text search over: name, email. Whitespace-separated terms must all match; at most 8 terms, and at most 600 bytes however a URL or a form encodes it.",
		)
	})
})

/* QL8 of r22b: limit's text and examples are the endpoint's own */
describe("limitParamMeta", () => {
	it("names the default and the cap, with each as an example, once when they are one", () => {
		expect(limitParamMeta(5, 10)).toEqual({
			description:
				"Maximum number of items per page, in decimal digits, zero-padded to at most 2 of them. Defaults to 5, at most 10.",
			examples: [5, 10],
		})
		expect(limitParamMeta(10, 10).examples).toEqual([10])
	})
})

/* CS7, QL8 of r22b: select's examples are the endpoint's fields, never a fixed list */
describe("selectParamMeta", () => {
	it("gives the first scalars, a relation with one of its fields, and *", () => {
		const meta = selectParamMeta({
			relationFields: { author: ["name", "email"] },
			relations: ["tags", "author"],
			scalars: ["id", "title", "body", "created_at"],
		})
		expect(meta.examples).toEqual(["id,title,body", "id,author(name)", "*"])
		expect(meta.description).toContain("Fields: id, title, body, created_at.")
		expect(meta.description).toContain(
			"Relations, each with the fields it selects: tags (none); author (name, email); none nests another.",
		)
	})

	it("gives * alone where nothing is declared, and a relation alone where no scalar is", () => {
		const bare = selectParamMeta({ scalars: [] })
		expect(bare.examples).toEqual(["*"])
		expect(bare.description).toContain("Fields: none. No relations.")
		expect(
			selectParamMeta({ relationFields: { author: ["name"] }, relations: ["author"], scalars: [] }).examples,
		).toEqual(["author(name)", "*"])
	})

	it("takes no relationFields key the config inherits", () => {
		const inherited = Object.create({ author: ["name"] }) as Record<string, readonly string[]>
		expect(selectParamMeta({ relationFields: inherited, relations: ["author"], scalars: ["id"] }).examples).toEqual([
			"id",
			"*",
		])
	})
})

describe("orderParamMeta: an example takes no more keys than the endpoint (QL8 of r22b)", () => {
	it("gives a second key alone where the endpoint takes one", () => {
		expect(orderParamMeta(["a", "b"], 1).examples).toEqual(["a.desc", "b.asc"])
	})
})

/* U11 of the 0.12 round: a byte cap a request meets is named where its field is described */
describe("the filter and search descriptions name their byte caps", () => {
	it("says how many bytes each takes however a URL or a form encodes it", () => {
		expect(filterParamMeta({ title: "string" }, () => ["eq"], FILTER_LIMITS).description).toContain(
			"at most 4608 bytes however a URL or a form encodes it",
		)
		expect(searchParamMeta(["title"], 8).description).toContain("at most 600 bytes however a URL or a form encodes it")
	})
})
