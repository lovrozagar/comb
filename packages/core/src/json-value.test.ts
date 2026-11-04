import * as z from "zod"
import { describe, expect, it } from "vitest"
import { jsonValue } from "./json-value.ts"

describe("jsonValue", () => {
	it.each(["text", 1.5, true, null, [1, null, [{}]], { a: { b: [null] } }])("takes the JSON value %j", (value) => {
		expect(jsonValue.safeParse(value).success).toBe(true)
	})

	it.each([undefined, Number.NaN, () => 1, { a: undefined }])("refuses %s, no JSON value", (value) => {
		expect(jsonValue.safeParse(value).success).toBe(false)
	})

	it("publishes one definition under CombJsonValue that its recursion refers to", () => {
		const published = z.toJSONSchema(z.object({ a: jsonValue, b: z.array(jsonValue) }))
		expect(Object.keys(published.$defs ?? {})).toEqual(["CombJsonValue"])
		expect(JSON.stringify(published.$defs?.["CombJsonValue"])).toContain('"$ref":"#/$defs/CombJsonValue"')
	})
})
