import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
	createListQuerySchema,
	createRetrieveQuerySchema,
	defineListQuery,
	PAGINATION_DEFAULTS,
} from "../../../src/query/schema.ts"

describe("createListQuerySchema", () => {
	const schema = createListQuerySchema({
		filter: { status: "enum", type: "string" },
		sort: ["createdAt", "name"] as const,
	})

	it("parses valid input with defaults", () => {
		const result = schema.safeParse({})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.limit).toBe(PAGINATION_DEFAULTS.defaultLimit)
			expect(result.data.parsedSort).toHaveLength(1)
			expect(result.data.parsedSort[0]?.field).toBe("createdAt")
		}
	})

	it("validates sort fields", () => {
		const result = schema.safeParse({ order: "unknown.desc" })
		expect(result.success).toBe(false)
	})

	it("validates filter", () => {
		const result = schema.safeParse({ filter: "status.eq.active" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.filterAst).toBeTruthy()
		}
	})

	it("rejects unknown filter fields", () => {
		const result = schema.safeParse({ filter: "bad.eq.x" })
		expect(result.success).toBe(false)
	})

	it("accepts cursor + page together and lets cursor take precedence", () => {
		const result = schema.safeParse({ cursor: "abc", page: 2 })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.cursor).toBe("abc")
			expect(result.data.page).toBe(2)
		}
	})

	it("respects custom pagination limits", () => {
		const customSchema = createListQuerySchema({
			pagination: { defaultLimit: 5, maxLimit: 10 },
			sort: ["createdAt"] as const,
		})
		const result = customSchema.safeParse({})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.limit).toBe(5)
		}
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
		const result = schema.safeParse({ order: "name.desc" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.sortOrderBy).toEqual({ name: "desc" })
		}
	})

	it("supports extend with extra fields", () => {
		const extended = createListQuerySchema({
			extend: { tag: z.string().optional() },
			sort: ["createdAt"] as const,
		})
		const result = extended.safeParse({ tag: "featured" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.tag).toBe("featured")
		}
	})

	it("passes through q param", () => {
		const result = schema.safeParse({ q: "search term" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.q).toBe("search term")
		}
	})

	it("defaults unprefixed order field to asc", () => {
		const result = schema.safeParse({ order: "name" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.parsedSort[0]?.direction).toBe("asc")
			expect(result.data.sortOrderBy).toEqual({ name: "asc" })
		}
	})

	it("treats field.desc as desc", () => {
		const result = schema.safeParse({ order: "name.desc" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.parsedSort[0]?.direction).toBe("desc")
		}
	})

	it("defaults to first config field with desc when no order param", () => {
		const result = schema.safeParse({})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.parsedSort).toHaveLength(1)
			expect(result.data.parsedSort[0]?.field).toBe("createdAt")
			expect(result.data.parsedSort[0]?.direction).toBe("desc")
		}
	})

	it("keeps nullable and undefined output keys in the parsed result", () => {
		const result = schema.safeParse({})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data).toHaveProperty("cursor", undefined)
			expect(result.data).toHaveProperty("lang", undefined)
			expect(result.data).toHaveProperty("page", undefined)
			expect(result.data).toHaveProperty("q", undefined)
			expect(result.data).toHaveProperty("filterAst", null)
			expect(result.data).toHaveProperty("parsedFields", null)
		}
	})

	it("parses multiple order entries in order", () => {
		const result = schema.safeParse({ order: "createdAt.desc,name" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.parsedSort).toEqual([
				{ direction: "desc", field: "createdAt" },
				{ direction: "asc", field: "name" },
			])
			expect(result.data.sortOrderBy).toEqual({
				createdAt: "desc",
				name: "asc",
			})
		}
	})

	it("parses order with .nullsfirst suffix", () => {
		const result = schema.safeParse({ order: "name.asc.nullsfirst" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.parsedSort[0]).toEqual({
				direction: "asc",
				field: "name",
				nulls: "first",
			})
		}
	})

	it("parses order with .desc.nullslast suffix", () => {
		const result = schema.safeParse({ order: "createdAt.desc.nullslast" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.parsedSort[0]).toEqual({
				direction: "desc",
				field: "createdAt",
				nulls: "last",
			})
		}
	})
})

describe("createRetrieveQuerySchema", () => {
	const schema = createRetrieveQuerySchema({
		fields: {
			relations: ["author"],
			scalars: ["id", "name", "email"],
		},
	})

	it("parses valid input", () => {
		const result = schema.safeParse({ lang: "en", select: "id,name" })
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.lang).toBe("en")
			expect(result.data.parsedFields?.root.scalars).toEqual(["id", "name"])
		}
	})

	it("rejects unknown fields", () => {
		const result = schema.safeParse({ select: "id,unknown" })
		expect(result.success).toBe(false)
	})

	it("rejects unknown relations", () => {
		const result = schema.safeParse({ select: "posts(*)" })
		expect(result.success).toBe(false)
	})

	it("returns null parsedFields when no select param", () => {
		const result = schema.safeParse({})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.parsedFields).toBeNull()
		}
	})
})

describe("createListQuerySchema → JSON Schema", () => {
	it("z.toJSONSchema with io:input returns object schema with core query properties", () => {
		const schema = createListQuerySchema({ sort: ["createdAt"] as const })
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		expect(jsonSchema.type).toBe("object")
		const props = jsonSchema.properties as Record<string, unknown>
		expect(props).toBeDefined()
		for (const key of ["cursor", "filter", "limit", "order", "page", "q", "select"]) {
			expect(Object.keys(props)).toContain(key)
		}
	})

	it("z.toJSONSchema with io:input includes lang property (lang is in base shape)", () => {
		const schema = createListQuerySchema({ sort: ["createdAt"] as const })
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		expect(jsonSchema.type).toBe("object")
		const props = jsonSchema.properties as Record<string, unknown>
		expect(Object.keys(props)).toContain("lang")
	})

	/* pins the reason Honey must pass io:input — if Zod stops throwing, revisit */
	it("z.toJSONSchema with default options THROWS due to unrepresentable custom types in pipe output", () => {
		const schema = createListQuerySchema({ sort: ["createdAt"] as const })
		expect(() => z.toJSONSchema(schema)).toThrow()
	})

	it("emits description + examples for every list query param under io:input", () => {
		const schema = createListQuerySchema({
			fields: { scalars: ["id", "name"] },
			sort: ["createdAt"] as const,
		})
		const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
		const props = jsonSchema.properties as Record<string, Record<string, unknown>>
		for (const key of ["cursor", "filter", "limit", "page", "q", "order", "select"] as const) {
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
		const schema = createRetrieveQuerySchema({ fields: { scalars: ["id", "name"] } })
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

describe("defineListQuery", () => {
	it("builds capabilities from config", () => {
		const { capabilities } = defineListQuery({
			filter: { status: "enum" },
			search: ["title"],
			sort: ["createdAt", "name"],
		})

		expect(capabilities.filterFields).toEqual({ status: "enum" })
		expect(capabilities.sortFields.has("createdAt")).toBe(true)
		expect(capabilities.searchFields.has("title")).toBe(true)
		expect(capabilities.pagination.defaultLimit).toBe(PAGINATION_DEFAULTS.defaultLimit)
	})

	it("uses custom pagination", () => {
		const { capabilities } = defineListQuery({
			pagination: { defaultLimit: 50, maxLimit: 200 },
			sort: ["id"],
		})
		expect(capabilities.pagination.defaultLimit).toBe(50)
		expect(capabilities.pagination.maxLimit).toBe(200)
	})
})
