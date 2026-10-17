import { describe, expect, it } from "vitest"
import { parseField } from "../../analyze-field.ts"
import type { FieldMeta } from "../../analyzer-types.ts"
import { generateExampleMeta, SHARED_META_KEYS, SHARED_META_VALUES } from "./example-meta.ts"

const field = (raw: string, overrides: Partial<FieldMeta> = {}): FieldMeta => ({
	...parseField("f", raw),
	...overrides,
})
const code = (raw: string, overrides: Partial<FieldMeta> = {}) =>
	generateExampleMeta(field(raw, overrides))?.code ?? null

describe("generateExampleMeta", () => {
	it("gives private, password, reference, JSON and timestamp columns no example", () => {
		for (const raw of [
			'c.text("f", { private: true })',
			'c.text("f", { password: true })',
			'c.ref("f")',
			'c.json("f", schema)',
			'c.createdAt("created_at")',
			'c.timestamp("f")',
		]) {
			expect(code(raw)).toBeNull()
		}
		expect(code('text("f")', { foreignKey: { column: "f", refColumn: "id", refTable: "t" } })).toBeNull()
	})

	it("uses the shared examples for email, url, serial ids, booleans and plain text", () => {
		expect(generateExampleMeta(field('c.text("f", { email: true })'))).toEqual({
			code: ".meta(_m.email)",
			needsSharedMeta: true,
		})
		expect(code('c.text("f", { url: true })')).toBe(".meta(_m.url)")
		expect(code("c.serialId()")).toBe(".meta(_m.serialId)")
		expect(code('c.boolean("f")')).toBe(".meta(_m.boolean)")
		expect(code('c.text("f")')).toBe(".meta(_m.string)")
	})

	it("writes per-field examples inline: the id prefix, the first enum value, exact lengths", () => {
		expect(generateExampleMeta(field('c.id("usr")'))).toEqual({
			code: '.meta({ examples: ["usr_01h5a3g8k9m2n4p6q8r0t2v4x6"] })',
			needsSharedMeta: false,
		})
		expect(code("c.id(prefix)")).toBe('.meta({ examples: ["id_01h5a3g8k9m2n4p6q8r0t2v4x6"] })')
		expect(code('c.enum("f", ["a", "b"])', { enumValues: ["a", "b"] })).toBe('.meta({ examples: ["a"] })')
		expect(code('c.text("f", { min: 4, max: 4 })')).toBe('.meta({ examples: ["a1b2"] })')
	})

	it("takes a bounded number's midpoint, unless it is the shared example", () => {
		expect(code('c.integer("f", { min: 0, max: 10 })')).toBe(".meta({ examples: [5] })")
		expect(code('c.integer("f", { min: 0, max: 84 })')).toBe(".meta(_m.integer)")
		expect(code('c.integer("f")')).toBe(".meta(_m.integer)")
		expect(code('c.real("f", { min: 0, max: 3 })')).toBe(".meta({ examples: [1.5] })")
		expect(code('c.real("f", { min: 0, max: 1 })')).toBe(".meta(_m.real)")
		expect(code('c.real("f")')).toBe(".meta(_m.real)")
	})

	it("gives an unknown column no example", () => {
		expect(code('integer("f")')).toBeNull()
	})

	it("declares a shared value for every shared key", () => {
		expect(Object.keys(SHARED_META_VALUES).sort()).toEqual([...SHARED_META_KEYS].sort())
	})
})

describe("generateExampleMeta: typed columns", () => {
	it("gives a column typed by a named schema no string example", () => {
		expect(generateExampleMeta(parseField("p", 'c.text("p").$type<z.infer<typeof prefs>>()'))).toBeNull()
	})
})
