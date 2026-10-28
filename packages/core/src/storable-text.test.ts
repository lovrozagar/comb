import { describe, expect, it } from "vitest"
import * as z from "zod"
import { isStorableText, storableText } from "./index.ts"

/* G1 of the 0.13.1 consumers review: the rule generated write DTOs hold text to, for an app's own schemas */
describe("isStorableText", () => {
	it("takes text every engine stores as sent, a surrogate pair included", () => {
		for (const text of ["", "plain", "a😀b", "😀", "�"]) expect(isStorableText(text), text).toBe(true)
	})

	it("refuses U+0000 and a lone surrogate, high or low", () => {
		for (const text of ["a\u0000b", "\uD800", "a\uDBFFz", "\uDC00", "\uDE00\uD83D"])
			expect(isStorableText(text)).toBe(false)
	})
})

describe("storableText", () => {
	it("is a string schema that refuses what isStorableText refuses", () => {
		const schema = storableText()
		expect(schema.safeParse("a😀b").success).toBe(true)
		expect(schema.safeParse("a\u0000b").error?.issues[0]?.message).toBe(
			"Must not contain U+0000 or an unpaired surrogate",
		)
		expect(schema.safeParse(1).success).toBe(false)
	})

	it("publishes the rule as x-comb-text, never as a pattern", () => {
		expect(z.toJSONSchema(storableText())).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "string",
			"x-comb-text": "no U+0000 or unpaired surrogate",
		})
	})

	it("is a new schema each call, so a caller's meta stays its own", () => {
		expect(storableText()).not.toBe(storableText())
	})
})
