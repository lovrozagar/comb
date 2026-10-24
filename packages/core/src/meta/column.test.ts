import { describe, expect, it } from "vitest"
import { combColumnMeta, withCombColumn } from "./column.ts"

describe("withCombColumn and combColumnMeta", () => {
	it("records the options a helper was given on the builder's config, and leaves out the rest", () => {
		const builder = { config: {} }
		expect(withCombColumn(builder, { constraints: undefined, kind: "text", prefix: undefined })).toBe(builder)
		expect(combColumnMeta(builder)).toEqual({ kind: "text" })
		/* under the registered symbol, so another copy of comb reads it */
		expect(Object.getOwnPropertySymbols(builder.config).map((symbol) => Symbol.keyFor(symbol))).toEqual(["comb.column"])
	})

	it("reads nothing from a value with no config, or a config no c helper wrote", () => {
		for (const value of [undefined, null, {}, { config: {} }]) expect(combColumnMeta(value)).toBeUndefined()
	})
})
