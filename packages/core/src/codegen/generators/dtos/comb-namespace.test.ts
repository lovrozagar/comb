import { describe, expect, it } from "vitest"
import { COMB_NAMESPACE, combImport } from "./comb-namespace.ts"

describe("comb's namespace in generated code (C2 of r17)", () => {
	it("is named by a member of comb, never by combMeta or a name that ends in comb", () => {
		expect(COMB_NAMESPACE.test(".refine(comb.isStorableText, {")).toBe(true)
		expect(COMB_NAMESPACE.test("combMeta({ kind })")).toBe(false)
		expect(COMB_NAMESPACE.test("honeycomb.x")).toBe(false)
	})

	it("is imported whole from where comb is imported", () => {
		expect(combImport("@lovrozagar/comb")).toBe('import * as comb from "@lovrozagar/comb"')
	})
})
