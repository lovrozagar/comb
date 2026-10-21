import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createCursor, MAX_CURSOR_LENGTH } from "./cursor.ts"
import { createListQuerySchema } from "./list-schema.ts"
import { createRetrieveQuerySchema } from "./retrieve-schema.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"
import { SIGNED } from "./__fixtures__/cursor-secret.ts"

/** Returns a safeParse result's data; fails the test with the issues when the parse failed. */
function dataOf<T>(result: { success: true; data: T } | { success: false; error: { message: string } }): T {
	if (!result.success) throw new Error(`expected a successful parse: ${result.error.message}`)
	return result.data
}

/** The input JSON Schema properties of a query schema. */
function inputProps(schema: z.ZodType) {
	return (z.toJSONSchema(schema, { io: "input" }) as { properties: Record<string, Record<string, unknown>> }).properties
}

/** A list schema with an enum filter and two sort fields, shared by the parse tests. */
const listSchema = createListQuerySchema({
	filter: { status: "enum", type: "string" },
	sort: ["createdAt", "name"] as const,
})

describe("createListQuerySchema — defaults and validation", () => {
	it("parses valid input with defaults", () => {
		const result = listSchema.safeParse({})
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.limit).toBe(PAGINATION_DEFAULTS.defaultLimit)
		expect(data.parsedSort).toHaveLength(1)
		expect(data.parsedSort[0]?.field).toBe("createdAt")
		expect(data.parsedFields).toBeNull()
	})

	it("rejects a select param when fields is omitted", () => {
		expect(listSchema.safeParse({ select: "id" }).success).toBe(false)
	})

	it("validates sort fields", () => {
		const result = listSchema.safeParse({ order: "unknown.desc" })
		expect(result.success).toBe(false)
	})

	it("validates filter", () => {
		const result = listSchema.safeParse({ filter: "status.eq.active" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.filterAst).toBeTruthy()
	})

	it("rejects unknown filter fields", () => {
		const result = listSchema.safeParse({ filter: "bad.eq.x" })
		expect(result.success).toBe(false)
	})

	it("accepts cursor + page together and lets cursor take precedence", () => {
		const cursor = createCursor({ createdAt: 1, id: "abc" }, [{ direction: "desc", field: "createdAt" }], SIGNED)
		const result = listSchema.safeParse({ cursor, page: 2 })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.cursor).toBe(cursor)
		expect(data.page).toBe(2)
	})

	it("rejects a cursor that does not decode", () => {
		expect(listSchema.safeParse({ cursor: "abc" }).success).toBe(false)
	})
})

describe("createListQuerySchema — pagination, extend and search", () => {
	it("respects custom pagination limits", () => {
		const customSchema = createListQuerySchema({
			pagination: { defaultLimit: 5, maxLimit: 10 },
			sort: ["createdAt"] as const,
		})
		const result = customSchema.safeParse({})
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.limit).toBe(5)
	})

	it("clamps limit to max", () => {
		const customSchema = createListQuerySchema({
			pagination: { maxLimit: 10 },
			sort: ["createdAt"] as const,
		})
		const result = customSchema.safeParse({ limit: 999 })
		expect(result.success).toBe(false)
	})

	it("builds sortOrderBy object", () => {
		const result = listSchema.safeParse({ order: "name.desc" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.sortOrderBy).toEqual({ name: "desc" })
	})

	it("supports extend with extra fields", () => {
		const extended = createListQuerySchema({
			extend: { tag: z.string().optional() },
			sort: ["createdAt"] as const,
		})
		const result = extended.safeParse({ tag: "featured" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.tag).toBe("featured")
	})

	it("passes through q param when search is declared", () => {
		const searchable = createListQuerySchema({ search: ["name"], sort: ["createdAt"] as const })
		const result = searchable.safeParse({ q: "search term" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.q).toBe("search term")
	})
})

describe("createListQuerySchema — order", () => {
	it("defaults unprefixed order field to asc", () => {
		const result = listSchema.safeParse({ order: "name" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.parsedSort[0]?.direction).toBe("asc")
		expect(data.sortOrderBy).toEqual({ name: "asc" })
	})

	it("treats field.desc as desc", () => {
		const result = listSchema.safeParse({ order: "name.desc" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.parsedSort[0]?.direction).toBe("desc")
	})

	it("defaults to first config field with desc when no order param", () => {
		const result = listSchema.safeParse({})
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.parsedSort).toHaveLength(1)
		expect(data.parsedSort[0]?.field).toBe("createdAt")
		expect(data.parsedSort[0]?.direction).toBe("desc")
	})
})

describe("createListQuerySchema — parsed output", () => {
	it("keeps nullable and undefined output keys in the parsed result", () => {
		const result = listSchema.safeParse({})
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data).toHaveProperty("cursor", undefined)
		expect(data).toHaveProperty("lang", undefined)
		expect(data).toHaveProperty("page", undefined)
		expect(data).toHaveProperty("q", undefined)
		expect(data).toHaveProperty("filterAst", null)
		expect(data).toHaveProperty("parsedFields", null)
	})
})

describe("createListQuerySchema — order lists and nulls", () => {
	it("parses multiple order entries in order", () => {
		const result = listSchema.safeParse({ order: "createdAt.desc,name" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.parsedSort).toEqual([
			{ direction: "desc", field: "createdAt" },
			{ direction: "asc", field: "name" },
		])
		expect(data.sortOrderBy).toEqual({
			createdAt: "desc",
			name: "asc",
		})
	})

	it("parses order with .nullsfirst suffix", () => {
		const result = listSchema.safeParse({ order: "name.asc.nullsfirst" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.parsedSort[0]).toEqual({
			direction: "asc",
			field: "name",
			nulls: "first",
		})
	})

	it("parses order with .desc.nullslast suffix", () => {
		const result = listSchema.safeParse({ order: "createdAt.desc.nullslast" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.parsedSort[0]).toEqual({
			direction: "desc",
			field: "createdAt",
			nulls: "last",
		})
	})
})

describe("createListQuerySchema — parsed fields", () => {
	it("populates parsedFields as data when fields is set", () => {
		const withFields = createListQuerySchema({
			fields: {
				relationFields: { author: ["id", "name"] },
				relations: ["author"],
				scalars: ["id", "name"],
			},
			sort: ["createdAt"] as const,
		})
		const result = withFields.safeParse({ select: "id,author(name)" })
		expect(result.success).toBe(true)
		const data = dataOf(result)
		expect(data.parsedFields).toEqual({
			root: {
				relations: { author: { relations: {}, scalars: ["name"] } },
				scalars: ["id"],
			},
		})
		expect(data.parsedFields).not.toHaveProperty("hasRelation")
	})
})

describe("createListQuerySchema → JSON Schema", () => {
	it("z.toJSONSchema with io:input returns object schema with core query properties", () => {
		const schema = createListQuerySchema({ sort: ["createdAt"] as const })
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		expect(jsonSchema.type).toBe("object")
		const props = jsonSchema.properties as Record<string, unknown>
		expect(props).toBeDefined()
		expect(Object.keys(props).sort()).toEqual(["cursor", "limit", "order", "page"])
	})

	it("omits select from the input schema when fields is not set", () => {
		const schema = createListQuerySchema({ sort: ["createdAt"] as const })
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		const props = jsonSchema.properties as Record<string, unknown>
		expect(Object.keys(props)).not.toContain("select")
	})

	it("includes select in the input schema when fields is set", () => {
		const schema = createListQuerySchema({
			fields: { scalars: ["id", "name"] },
			sort: ["createdAt"] as const,
		})
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		const props = jsonSchema.properties as Record<string, unknown>
		expect(Object.keys(props)).toContain("select")
	})

	it("z.toJSONSchema with io:input includes lang property when lang is declared", () => {
		const schema = createListQuerySchema({ lang: true, sort: ["createdAt"] as const })
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		expect(jsonSchema.type).toBe("object")
		const props = jsonSchema.properties as Record<string, unknown>
		expect(Object.keys(props)).toContain("lang")
	})
})

describe("createListQuerySchema → JSON Schema descriptions", () => {
	it("z.toJSONSchema with default options succeeds because pipe output is a real object tree", () => {
		const schema = createListQuerySchema({ sort: ["createdAt"] as const })
		const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
		expect(jsonSchema.type).toBe("object")
		const props = jsonSchema.properties as Record<string, unknown>
		expect(Object.keys(props)).toContain("parsedFields")
		expect(Object.keys(props)).toContain("filterAst")
	})

	it("emits description + examples for every list query param under io:input", () => {
		const schema = createListQuerySchema({
			fields: { scalars: ["id", "name"] },
			filter: { name: "string" },
			lang: true,
			search: ["name"],
			sort: ["createdAt"] as const,
		})
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		const props = jsonSchema.properties as Record<string, Record<string, unknown>>
		for (const key of ["cursor", "filter", "lang", "limit", "page", "q", "order", "select"] as const) {
			const entry = props[key]
			expect(entry, `props.${key} must exist`).toBeDefined()
			expect(typeof entry?.description, `props.${key}.description must be string`).toBe("string")
			expect(
				(entry?.description as string | undefined)?.length ?? 0,
				`props.${key}.description must be non-empty`,
			).toBeGreaterThan(10)
			expect(Array.isArray(entry?.examples), `props.${key}.examples must be array`).toBe(true)
			expect(
				(entry?.examples as unknown[] | undefined)?.length ?? 0,
				`props.${key}.examples must be non-empty`,
			).toBeGreaterThan(0)
		}
	})

	it("emits description + examples for retrieve query params", () => {
		const schema = createRetrieveQuerySchema({ fields: { scalars: ["id", "name"] }, lang: true })
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		const props = jsonSchema.properties as Record<string, Record<string, unknown>>
		for (const key of ["select", "lang"] as const) {
			const entry = props[key]
			expect(entry, `props.${key} must exist`).toBeDefined()
			expect(typeof entry?.description, `props.${key}.description must be string`).toBe("string")
			expect(Array.isArray(entry?.examples), `props.${key}.examples must be array`).toBe(true)
		}
	})

	it("uses renamed select key (not fields) in JSON Schema properties", () => {
		const schema = createListQuerySchema({
			fields: { scalars: ["id"] },
			sort: ["createdAt"] as const,
		})
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		const props = jsonSchema.properties as Record<string, unknown>
		expect(Object.keys(props)).toContain("select")
		expect(Object.keys(props)).not.toContain("fields")
	})
})

describe("createListQuerySchema — advertises only what it honors", () => {
	it("rejects unknown query keys", () => {
		const schema = createListQuerySchema({ sort: ["created_at"] })
		expect(schema.safeParse({ name: "eq.x" }).success).toBe(false)
	})

	it("omits filter when no filter fields are declared", () => {
		const schema = createListQuerySchema({ sort: ["created_at"] })
		expect(inputProps(schema)).not.toHaveProperty("filter")
		expect(schema.safeParse({ filter: "name.eq.x" }).success).toBe(false)
	})

	it("omits q unless search is declared", () => {
		expect(inputProps(createListQuerySchema({ sort: ["created_at"] }))).not.toHaveProperty("q")
		expect(inputProps(createListQuerySchema({ search: ["name"], sort: ["created_at"] }))).toHaveProperty("q")
	})

	it("omits lang unless lang is declared", () => {
		expect(inputProps(createListQuerySchema({ sort: ["created_at"] }))).not.toHaveProperty("lang")
		expect(inputProps(createListQuerySchema({ lang: true, sort: ["created_at"] }))).toHaveProperty("lang")
	})
})

describe("createListQuerySchema — advertised descriptions", () => {
	it("describes filter and order with the declared fields only", () => {
		const schema = createListQuerySchema({
			filter: { created_at: "number", name: "string" },
			sort: ["created_at", "name"],
		})
		const { filter, order } = inputProps(schema)
		expect(String(filter?.["description"])).toContain("name (string:")
		expect(String(filter?.["description"])).toContain("created_at (number:")
		expect(String(order?.["description"])).toContain("created_at, name")
		const examples = JSON.stringify([filter?.["examples"], order?.["examples"]])
		expect(examples).not.toContain("createdAt")
		expect(examples).not.toContain("status")
		expect(examples).toContain("name")
		expect(new RegExp(String(order?.["pattern"])).test("name.asc,created_at.desc.nullslast")).toBe(true)
		expect(new RegExp(String(order?.["pattern"])).test("slug.asc")).toBe(false)
	})
})

describe("createListQuerySchema — generated examples and facts", () => {
	it("every generated example parses under the schema", () => {
		const schema = createListQuerySchema({
			filter: { active: "boolean", created_at: "date", name: "string", role: "enum", size: "number" },
			search: ["name"],
			sort: ["created_at", "name"],
		})
		const { filter, order } = inputProps(schema)
		const filterExamples = (filter?.["examples"] ?? []) as string[]
		const orderExamples = (order?.["examples"] ?? []) as string[]
		expect(filterExamples.length).toBeGreaterThan(0)
		expect(orderExamples.length).toBeGreaterThan(0)
		for (const example of filterExamples) {
			expect(schema.safeParse({ filter: example }).success).toBe(true)
		}
		for (const example of orderExamples) {
			expect(schema.safeParse({ order: example }).success).toBe(true)
		}
	})

	it("stamps query facts a consumer can map to structured capabilities", () => {
		const schema = createListQuerySchema({
			fields: { scalars: ["id", "name"] },
			filter: { created_at: "number", name: "string" },
			search: ["name"],
			sort: ["created_at", "name"],
		})
		const json = z.toJSONSchema(schema, { io: "input" }) as Record<string, Record<string, unknown>>
		const facts = json["x-comb"] as Record<string, unknown>
		expect(facts["searchable"]).toEqual(["name"])
		expect(facts["filterFields"]).toEqual([
			{ field: "created_at", ops: ["eq", "ne", "neq", "gt", "gte", "lt", "lte", "in", "nin", "is"], type: "number" },
			{ field: "name", ops: ["eq", "ne", "neq", "like", "ilike", "in", "nin", "is"], type: "string" },
		])
		expect(facts["nulls"]).toEqual(["first", "last"])
		expect(facts["maxFilterConditions"]).toBe(20)
		expect(facts["maxFilterDepth"]).toBe(3)
		expect(facts["maxInValues"]).toBe(50)
		expect(facts["maxFilterValues"]).toBe(60)
		expect(facts["maxSearchTerms"]).toBe(8)
		expect(facts["maxSortKeys"]).toBe(3)
	})

	it("rejects more sort keys than the limit", () => {
		const schema = createListQuerySchema({ sort: ["a", "b", "c", "d"] })
		expect(schema.safeParse({ order: "a.asc,b.asc,c.asc" }).success).toBe(true)
		expect(schema.safeParse({ order: "a.asc,b.asc,c.asc,d.asc" }).success).toBe(false)
	})
})

/** A valid title filter exactly `length` characters long */
const ofLength = (length: number) => `title.eq.${"x".repeat(length - "title.eq.".length)}`

describe("filter length (Q-L6)", () => {
	const schema = createListQuerySchema({ filter: { title: "string" }, sort: ["title"] })

	it("accepts a filter up to 2048 characters and refuses a longer one before parsing it", () => {
		expect(schema.safeParse({ filter: ofLength(2048) }).success).toBe(true)
		const result = schema.safeParse({ filter: ofLength(2049) })
		expect(result.success).toBe(false)
		expect(JSON.stringify(result.error?.issues).length).toBeLessThan(2000)
	})

	it("takes another cap through limits", () => {
		const tight = createListQuerySchema({
			filter: { title: "string" },
			limits: { maxFilterLength: 20 },
			sort: ["title"],
		})
		expect(tight.safeParse({ filter: ofLength(21) }).success).toBe(false)
	})
})

describe("cursor and order length (S-L1)", () => {
	const capped = createListQuerySchema({ sort: ["created_at", "title"] })

	it("refuses a cursor over MAX_CURSOR_LENGTH characters and an order over 200, valid as they otherwise are", () => {
		const sort = [{ direction: "asc" as const, field: "title" }]
		const long = createCursor({ id: "p1", title: "t".repeat(MAX_CURSOR_LENGTH) }, sort, SIGNED)
		const short = createCursor({ id: "p1", title: "t" }, sort, SIGNED)
		expect(capped.safeParse({ cursor: short, order: "title.asc" }).success).toBe(true)
		expect(capped.safeParse({ cursor: long, order: "title.asc" }).success).toBe(false)
		expect(capped.safeParse({ order: `title.asc${" ".repeat(200)}` }).success).toBe(false)
		expect(capped.safeParse({ order: "created_at.desc.nullslast,title.asc" }).success).toBe(true)
	})
})

describe("the parsed cursor (Q7)", () => {
	it("is the raw string the client sent, beside nothing decoded from it", () => {
		const schema = createListQuerySchema({ sort: ["title"] })
		const cursor = createCursor({ id: "p1", title: "t" }, [{ direction: "asc", field: "title" }], SIGNED)
		const parsed = schema.parse({ cursor, order: "title.asc" })
		expect(parsed.cursor).toBe(cursor)
		expect(Object.keys(parsed).sort()).toEqual([
			"cursor",
			"filterAst",
			"lang",
			"limit",
			"page",
			"parsedFields",
			"parsedSort",
			"q",
			"sortOrderBy",
			"validated",
		])
	})
})
