import { describe, expect, it } from "vitest"
import { isReference } from "./analyze-field.ts"

describe("isReference", () => {
	it("is a column with a foreign key, or a c.ref, which always is one", () => {
		const fk = { column: "a", refColumn: "id", refTable: "t" }
		expect(isReference({ combKind: "text", foreignKey: fk })).toBe(true)
		expect(isReference({ combKind: "ref", foreignKey: null })).toBe(true)
		expect(isReference({ combKind: null, foreignKey: null })).toBe(false)
	})
})
