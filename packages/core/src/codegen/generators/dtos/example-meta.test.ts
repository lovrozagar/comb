import { describe, expect, it } from "vitest"
import { parseField } from "../../__fixtures__/runtime.ts"
import type { FieldMeta } from "../../analyzer-types.ts"
import { generateExampleMeta, SHARED_META_KEYS, SHARED_META_VALUES } from "./example-meta.ts"

const field = (raw: string, overrides: Partial<FieldMeta> = {}): FieldMeta => ({
	...parseField("f", raw),
	...overrides,
})
const code = (raw: string, overrides: Partial<FieldMeta> = {}) =>
	generateExampleMeta(field(raw, overrides))?.code ?? null

describe("generateExampleMeta", () => {
	/* comb's own timestamp columns take timestampSchema, whose meta carries the example */
	it("gives private, password, reference, JSON and comb-filled timestamp columns no example", () => {
		for (const raw of [
			'c.text("f", { private: true })',
			'c.text("f", { password: true })',
			'c.ref("f")',
			'c.json("f", schema)',
			'c.createdAt("created_at")',
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
		expect(code("c.id(undefined)")).toBe('.meta({ examples: ["id_01h5a3g8k9m2n4p6q8r0t2v4x6"] })')
		expect(code('c.enum("f", ["a", "b"])', { enumValues: ["a", "b"] })).toBe('.meta({ examples: ["a"] })')
		expect(code('c.text("f", { min: 4, max: 4 })')).toBe('.meta({ examples: ["a1b2"] })')
	})

	it("takes the shared example when its bounds accept it, else their midpoint or the bound it misses (F18)", () => {
		expect(code('c.integer("f", { min: 0, max: 10 })')).toBe(".meta({ examples: [5] })")
		expect(code('c.integer("f", { min: 0, max: 84 })')).toBe(".meta(_m.integer)")
		expect(code('c.integer("f")')).toBe(".meta(_m.integer)")
		expect(code('c.integer("f", { min: 100 })')).toBe(".meta({ examples: [100] })")
		expect(code('c.integer("f", { max: 7 })')).toBe(".meta({ examples: [7] })")
		expect(code('c.real("f", { min: 1, max: 3 })')).toBe(".meta({ examples: [2] })")
		expect(code('c.real("f", { min: 0, max: 3 })')).toBe(".meta(_m.real)")
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

/* a c.timestamp has its own range since F11, so no shared schema brings its example */
describe("generateExampleMeta: a c.timestamp's range (F11)", () => {
	it("gives the shared timestamp example its bounds accept, else a value inside them", () => {
		expect(code('c.timestamp("f")')).toBe(".meta(_m.timestamp)")
		expect(code('c.timestamp("f", { min: 0 })')).toBe(".meta(_m.timestamp)")
		expect(code('c.timestamp("f", { max: 0 })')).toBe(".meta({ examples: [0] })")
		expect(code('c.timestamp("f", { min: -100, max: 100 })')).toBe(".meta({ examples: [0] })")
	})
})

describe("generateExampleMeta: an email, URL or image URI its own bounds and rules accept (F31)", () => {
	it("gives each kind its own example, and none where the column is shorter than the example", () => {
		expect(generateExampleMeta(parseField("m", 'c.text("m", { email: true })'))?.code).toBe(".meta(_m.email)")
		expect(generateExampleMeta(parseField("m", 'c.text("m", { email: true, max: 10 })'))).toBeNull()
		expect(generateExampleMeta(parseField("u", 'c.text("u", { url: true, max: 12 })'))).toBeNull()
		expect(generateExampleMeta(parseField("i", 'c.text("i", { imageUri: true })'))?.code).toBe(
			'.meta({ examples: ["https://example.com/a.png"] })',
		)
		expect(generateExampleMeta(parseField("i", 'c.text("i", 20)'))?.code).toBe(".meta(_m.string)")
		expect(generateExampleMeta(parseField("i", 'c.text("i", { imageUri: true, max: 20 })'))).toBeNull()
	})
})
