/**
 * The published query facts must match what the parser actually accepts.
 *
 * These tests do not compare the stamp against a second declaration — that
 * would only prove two constants are equal. They drive the real schema with
 * real query strings and assert the parser agrees with what was published.
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { readCombQueryMeta } from "../../../src/meta.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"

const schema = createListQuerySchema({
	fields: {
		relationFields: { author: ["name"] },
		relations: ["author"],
		scalars: ["id", "status", "title", "created_at"],
	},
	filter: { created_at: "date", status: "enum", title: "string" },
	pagination: { defaultLimit: 10, maxLimit: 50 },
	sort: ["created_at", "title"],
})

function meta() {
	const published = readCombQueryMeta(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }))
	if (!published) throw new Error("createListQuerySchema did not stamp query meta")
	return published
}

describe("published query meta is present on both io views", () => {
	it("survives the transform/pipe on the output view too", () => {
		/* Stamping the base instead of the returned pipe passes the input view
		   and silently loses the output view — see docs/meta-contract.md §3.1. */
		const output = readCombQueryMeta(z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }))
		expect(output).toEqual(meta())
	})
})

describe("filterable matches the parser", () => {
	it("accepts every declared filterable field", () => {
		for (const field of meta().filterable) {
			const result = schema.safeParse({ filter: `${field}.eq.x` })
			expect(result.success, `declared filterable but rejected: ${field}`).toBe(true)
		}
	})

	it("rejects a field that was not declared", () => {
		expect(meta().filterable).not.toContain("secret")
		expect(schema.safeParse({ filter: "secret.eq.x" }).success).toBe(false)
	})
})

describe("sortable matches the parser", () => {
	it("accepts every declared sortable field, in both directions", () => {
		for (const field of meta().sortable) {
			for (const dir of ["asc", "desc"]) {
				const result = schema.safeParse({ order: `${field}.${dir}` })
				expect(result.success, `declared sortable but rejected: ${field}.${dir}`).toBe(true)
			}
		}
	})

	it("rejects a field that was not declared", () => {
		expect(meta().sortable).not.toContain("title_length")
		expect(schema.safeParse({ order: "title_length.asc" }).success).toBe(false)
	})
})

describe("selectable matches the parser", () => {
	it("accepts every declared selectable field", () => {
		for (const field of meta().selectable) {
			const result = schema.safeParse({ select: field })
			expect(result.success, `declared selectable but rejected: ${field}`).toBe(true)
		}
	})

	it("rejects a field that was not declared", () => {
		expect(meta().selectable).not.toContain("internal_note")
		expect(schema.safeParse({ select: "internal_note" }).success).toBe(false)
	})

	it("omits relation names, which are selectable only in the author(field) form", () => {
		/* A bare relation name parses as a scalar and is rejected. Publishing it
		   would invite a consumer to send select=author and read the 400 as a bug. */
		expect(meta().selectable).not.toContain("author")
		expect(schema.safeParse({ select: "author" }).success).toBe(false)
		expect(schema.safeParse({ select: "author(name)" }).success).toBe(true)
	})
})

describe("maxLimit matches the parser", () => {
	it("accepts the published maximum and rejects one past it", () => {
		const { maxLimit } = meta()
		expect(schema.safeParse({ limit: maxLimit }).success).toBe(true)
		expect(schema.safeParse({ limit: maxLimit + 1 }).success).toBe(false)
	})
})

describe("defaultOrder matches what the parser applies", () => {
	it("names the sort actually used when the request specifies none", () => {
		const parsed = schema.parse({})
		const [field, direction] = meta().defaultOrder.split(".")

		expect(parsed.parsedSort[0]?.field).toBe(field)
		expect(parsed.parsedSort[0]?.direction).toBe(direction)
	})
})

describe("searchable is null, not an empty list", () => {
	it("reports 'not knowable here' rather than 'nothing is searchable'", () => {
		/* `q` is resolved at buildListQuery, a different call site. Publishing []
		   would tell a consumer to skip search entirely. See docs §6.1. */
		expect(meta().searchable).toBeNull()
		expect(schema.safeParse({ q: "anything" }).success).toBe(true)
	})
})

describe("stableTiebreak matches the column the SQL builder uses", () => {
	it("names the shared constant, not an independently written string", async () => {
		const { CURSOR_TIEBREAK_COLUMN } = await import("../../../src/query/cursor.ts")
		expect(meta().stableTiebreak).toBe(CURSOR_TIEBREAK_COLUMN)
	})
})

describe("a config change moves the published facts with it", () => {
	it("tracks sort, filter and pagination without a second declaration", () => {
		const other = createListQuerySchema({
			fields: { scalars: ["id"] },
			filter: { archived: "boolean" },
			pagination: { maxLimit: 5 },
			sort: ["archived"],
		})
		const published = readCombQueryMeta(z.toJSONSchema(other, { io: "input", unrepresentable: "any" }))

		expect(published).toMatchObject({
			defaultOrder: "archived.desc",
			filterable: ["archived"],
			maxLimit: 5,
			selectable: ["id"],
			sortable: ["archived"],
		})
	})
})
