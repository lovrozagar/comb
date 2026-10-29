import { describe, expect, it } from "vitest"
import { namesColumn } from "./sql-name.ts"

describe("namesColumn (C5 of r17)", () => {
	it("finds a column by its quoted name, whatever characters the name holds", () => {
		expect(namesColumn('"tok(en" IS NULL', "tok(en")).toBe(true)
		expect(namesColumn("\"email\" <> 'ab'", "a+b")).toBe(false)
		expect(namesColumn('"a""b" = 1', 'a"b')).toBe(true)
	})

	it("never takes a name inside another quoted name, nor an unquoted word", () => {
		expect(namesColumn('"hidden_at" IS NULL', "hidden")).toBe(false)
		expect(namesColumn("hidden = 0", "hidden")).toBe(false)
	})
})
