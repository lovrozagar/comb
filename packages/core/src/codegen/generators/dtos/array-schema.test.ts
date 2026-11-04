import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { arrayBase } from "./array-schema.ts"
import { keyed, plain } from "./build-types.ts"

/* an element with a key of its own, as a text column's rule publishes one */
const TEXT = plain("z.string()", { "x-comb-text": "rule" })

/** The evaluated nullable schema of `base`, as finish writes a nullable column of it, its TypeScript transpiled */
const nullable = (base: ReturnType<typeof arrayBase>): z.ZodType =>
	new Function("z", ts.transpile(`return ${keyed(base.code, base, base.takesNull)}`))(z) as z.ZodType

describe("arrayBase", () => {
	it("writes exactly its declared dimensions, rectangular past one, a null element taken where declared", () => {
		const grid = nullable(arrayBase(TEXT, { dimensions: 2, nullable: true, schemaType: "create" }))
		expect(
			grid.safeParse([
				["a", null],
				["b", "c"],
			]).success,
		).toBe(true)
		expect(grid.safeParse(null).success).toBe(true)
		expect(grid.safeParse(["a"]).success).toBe(false)
		expect(grid.safeParse([["a"], ["b", "c"]]).success).toBe(false)
		expect(arrayBase(TEXT, { dimensions: 2, nullable: true, schemaType: "create" }).keys).toEqual({
			"x-comb-rectangular": true,
		})
		expect(arrayBase(TEXT, { dimensions: 1, nullable: true, schemaType: "create" }).keys).toEqual({})
	})

	it("refuses a written null element where the type declares none, and states the keys on it alone (A2-9 of r22)", () => {
		const shape = { dimensions: 2, nullable: false, schemaType: "create" } as const
		const grid = nullable(arrayBase(TEXT, shape))
		expect(grid.safeParse([["a", "b"]]).success).toBe(true)
		expect(grid.safeParse([["a", null]]).success).toBe(false)
		expect(grid.safeParse(null).success).toBe(true)
		const [array] = (z.toJSONSchema(grid, { io: "input" }) as { anyOf: Array<{ items: { items: object } }> }).anyOf
		expect(array?.items.items).toEqual({ type: "string", "x-comb-text": "rule" })
	})

	it("reads a null element whatever the type declares, as a read never refuses a stored row (F49)", () => {
		const read = nullable(arrayBase(TEXT, { dimensions: 1, nullable: false, schemaType: "read" }))
		expect(read.safeParse(["a", null]).success).toBe(true)
	})

	it("reads any depth Postgres holds, never ragged-refused, whatever dimensions it declares", () => {
		const read = nullable(arrayBase(TEXT, { dimensions: 1, nullable: true, schemaType: "read" }))
		expect(read.safeParse([["a", ["b"]], "c", null]).success).toBe(true)
		expect(arrayBase(TEXT, { dimensions: 2, nullable: true, schemaType: "read" }).keys).toEqual({})
	})

	it("states the element's keys on a nullable array's own items, at a written one's innermost level", () => {
		const written = z.toJSONSchema(nullable(arrayBase(TEXT, { dimensions: 2, nullable: true, schemaType: "create" })), {
			io: "input",
		})
		expect(written).toMatchObject({ items: { items: { "x-comb-text": "rule" } } })
		const read = z.toJSONSchema(nullable(arrayBase(TEXT, { dimensions: 2, nullable: true, schemaType: "read" })), {
			io: "output",
		})
		expect(read).toMatchObject({ items: { "x-comb-text": "rule" } })
	})

	it("states no items beside the anyOf for an element with no keys", () => {
		const base = arrayBase(plain("z.string()"), { dimensions: 1, nullable: true, schemaType: "create" })
		expect(base.besideNull).toEqual({})
		expect(z.toJSONSchema(nullable(base), { io: "input" })).not.toHaveProperty("items")
	})
})
