import { describe, expect, it } from "vitest"
import * as z from "zod"
import { keyed, metaOf, plain } from "./build-types.ts"

describe("plain", () => {
	it("is a base that takes no null of its own, with the keys and shared schemas it is given or none", () => {
		expect(plain("z.string()")).toEqual({ code: "z.string()", keys: {}, takesNull: false, uses: [] })
		expect(plain("cidrSchema", { "x-comb-text": "rule" }, ["cidrSchema"])).toEqual({
			code: "cidrSchema",
			keys: { "x-comb-text": "rule" },
			takesNull: false,
			uses: ["cidrSchema"],
		})
	})
})

describe("metaOf", () => {
	it("is the .meta of the keys given, and nothing for none", () => {
		expect(metaOf({})).toBe("")
		expect(metaOf({ "x-comb-text": "rule" })).toBe('.meta({"x-comb-text":"rule"})')
	})
})

/** The evaluated Zod expression `code` */
const evaluate = (code: string): z.ZodType => new Function("z", `return ${code}`)(z) as z.ZodType

describe("keyed", () => {
	it("puts the keys on a nullable and its member alike, and the keys beside null on the nullable alone", () => {
		const base = { besideNull: { "x-comb-beside": true }, keys: { "x-comb-text": "rule" } }
		const schema = evaluate(keyed("z.string()", base, false)) as z.ZodNullable<z.ZodString>
		expect(schema.safeParse(null).success).toBe(true)
		expect(z.toJSONSchema(schema)).toMatchObject({ "x-comb-beside": true, "x-comb-text": "rule" })
		expect(z.toJSONSchema(schema.unwrap())).toMatchObject({ "x-comb-text": "rule" })
		expect(z.toJSONSchema(schema.unwrap())).not.toHaveProperty("x-comb-beside")
	})

	it("adds no null to a base that takes null itself, nor the keys beside null", () => {
		const schema = evaluate(keyed("z.string()", { besideNull: { "x-comb-beside": true }, keys: {} }, true))
		expect(schema.safeParse(null).success).toBe(false)
		expect(z.toJSONSchema(schema)).not.toHaveProperty("x-comb-beside")
	})
})
