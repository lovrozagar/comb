import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createRetrieveQuerySchema } from "./retrieve-schema.ts"

/** Returns a safeParse result's data; fails the test with the issues when the parse failed. */
function dataOf<T>(result: { success: true; data: T } | { success: false; error: { message: string } }): T {
	if (!result.success) throw new Error(`expected a successful parse: ${result.error.message}`)
	return result.data
}

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
		const data = dataOf(result)
		expect(data.lang).toBe("en")
		expect(data.parsedFields?.root.scalars).toEqual(["id", "name"])
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
		const data = dataOf(result)
		expect(data.parsedFields).toBeNull()
	})
})

describe("createRetrieveQuerySchema — extension fields", () => {
	it("validates and returns the extended params beside lang and parsedFields", () => {
		const schema = createRetrieveQuerySchema({ extend: { include: z.enum(["stats"]) }, fields: { scalars: ["id"] } })
		expect(schema.parse({ include: "stats" })).toEqual({ include: "stats", lang: undefined, parsedFields: null })
		expect(schema.safeParse({ include: "other" }).success).toBe(false)
	})
})
