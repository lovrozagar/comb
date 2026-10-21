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
		lang: true,
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
		expect(schema.safeParse({ include: "stats", other: "x" }).success).toBe(false)
		expect(schema.safeParse({ include: "other" }).success).toBe(false)
	})
})

describe("createRetrieveQuerySchema — a param the endpoint does not honor (Q15)", () => {
	const schema = createRetrieveQuerySchema({ fields: { scalars: ["id"] } })

	it("refuses it, as the list schema does, rather than answer as if it were not sent", () => {
		expect(schema.safeParse({ filter: "owner_id.eq.42" }).success).toBe(false)
		expect(schema.safeParse({ select: "id" }).success).toBe(true)
	})

	it("takes lang only when the config says lang: true", () => {
		expect(schema.safeParse({ lang: "en" }).success).toBe(false)
		const localized = createRetrieveQuerySchema({ fields: { scalars: ["id"] }, lang: true })
		expect(localized.parse({ lang: "en" }).lang).toBe("en")
	})

	it("refuses an extension named like its params or outputs", () => {
		for (const key of ["lang", "parsedFields", "select"])
			expect(() => createRetrieveQuerySchema({ extend: { [key]: z.any() }, fields: { scalars: ["id"] } })).toThrow(
				TypeError,
			)
	})
})
