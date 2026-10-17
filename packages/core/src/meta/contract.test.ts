import { describe, expect, it } from "vitest"
import { COMB_FILTER_GRAMMAR, COMB_META_KEY, COMB_META_VERSION } from "./contract.ts"

describe("the meta contract's fixed values", () => {
	it("are the ones docs/meta-contract.md publishes", () => {
		expect({ COMB_FILTER_GRAMMAR, COMB_META_KEY, COMB_META_VERSION }).toEqual({
			COMB_FILTER_GRAMMAR: "postgrest",
			COMB_META_KEY: "x-comb",
			COMB_META_VERSION: 1,
		})
	})
})
