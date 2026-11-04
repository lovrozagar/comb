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
	it("writes exactly its declared dimensions, rectangular past one, a null element taken", () => {
		const grid = nullable(arrayBase(2, "create", TEXT))
		expect(
			grid.safeParse([
				["a", null],
				["b", "c"],
			]).success,
		).toBe(true)
		expect(grid.safeParse(null).success).toBe(true)
		expect(grid.safeParse(["a"]).success).toBe(false)
		expect(grid.safeParse([["a"], ["b", "c"]]).success).toBe(false)
		expect(arrayBase(2, "create", TEXT).keys).toEqual({ "x-comb-rectangular": true })
		expect(arrayBase(1, "create", TEXT).keys).toEqual({})
	})

	it("reads any depth Postgres holds, never ragged-refused, whatever dimensions it declares", () => {
		const read = nullable(arrayBase(1, "read", TEXT))
		expect(read.safeParse([["a", ["b"]], "c", null]).success).toBe(true)
		expect(arrayBase(2, "read", TEXT).keys).toEqual({})
	})

	it("states the element's keys on a nullable array's own items, at a written one's innermost level", () => {
		const written = z.toJSONSchema(nullable(arrayBase(2, "create", TEXT)), { io: "input" })
		expect(written).toMatchObject({ items: { items: { "x-comb-text": "rule" } } })
		const read = z.toJSONSchema(nullable(arrayBase(2, "read", TEXT)), { io: "output" })
		expect(read).toMatchObject({ items: { "x-comb-text": "rule" } })
	})

	it("states no items beside the anyOf for an element with no keys", () => {
		const base = arrayBase(1, "create", plain("z.string()"))
		expect(base.besideNull).toEqual({})
		expect(z.toJSONSchema(nullable(base), { io: "input" })).not.toHaveProperty("items")
	})
})
