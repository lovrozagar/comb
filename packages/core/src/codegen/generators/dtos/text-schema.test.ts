import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseField } from "../../__fixtures__/runtime.ts"
import type { FieldMeta } from "../../analyzer-types.ts"
import type { Build } from "./build-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { isStorableText, STORABLE_TEXT_RULE } from "../../../storable-text.ts"
import { stated, textBase } from "./text-schema.ts"

type Pin = Partial<FieldMeta> & { dialect?: Build["dialect"] }

/** The text schema of `raw` in a `schemaType` DTO on a dialect (SQLite by default), the column's own facts pinned over it */
function text(raw: string, schemaType: SchemaType, { dialect = "sqlite", ...over }: Pin = {}) {
	const field = { ...parseField("t", raw), ...over }
	return textBase({
		annotations: field.constraints,
		dialect,
		field,
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
		schemaType,
	})
}

/* generated code names comb's isStorableText under comb's namespace, which the generated file imports (C2 of r17) */
const parse = (code: string) => new Function("z", "comb", `return ${code}`)(z, { isStorableText }) as z.ZodString

/* F65: a read never refuses a stored row; it states the declared bounds and enforces what the engine holds */
describe("textBase on a read (F65)", () => {
	it("states a declared length and comb's id length, enforcing neither", () => {
		for (const type of ["read", "readPartial"] as const) {
			expect(text('c.text("t", { min: 3, max: 10 })', type)).toBe(
				'z.string().meta({"x-comb-maxLength":10,"x-comb-minLength":3})',
			)
			expect(text('c.id("usr")', type)).toBe('z.string().meta({"x-comb-maxLength":48,"x-comb-minLength":1})')
		}
		expect(parse(text('c.text("t", { min: 3, max: 10 })', "read")).safeParse("a stored row past ten").success).toBe(
			true,
		)
		expect(text('c.text("t", { email: true, max: 20 })', "read")).toBe('z.string().meta({"x-comb-maxLength":20})')
		expect(text('c.text("t")', "read")).toBe("z.string()")
	})

	it("states a SQLite length, which SQLite never holds a column to, and enforces a Postgres one", () => {
		expect(text('c.text("t")', "read", { length: 4 })).toBe('z.string().meta({"x-comb-maxLength":4})')
		expect(text('c.text("t")', "read", { dialect: "postgres", length: 4 })).toBe("z.string().max(4)")
		/* a declared max under a Postgres length is stated beside the length the column holds */
		expect(text('c.text("t", { max: 3 })', "read", { dialect: "postgres", length: 4 })).toBe(
			'z.string().max(4).meta({"x-comb-maxLength":3})',
		)
	})

	it("reads a password's stored hash as any string", () => {
		expect(text('c.text("t", { password: true, min: 12, pattern: "/^a/" })', "read")).toBe("z.string()")
	})
})

describe("textBase on a write", () => {
	it("enforces every declared bound and the text guard", () => {
		const write = text('c.text("t", { min: 3, max: 10 }).notNull()', "create")
		expect(write).toBe(
			`z.string().min(3).max(10).refine(comb.isStorableText, { message: "Must not contain U+0000 or an unpaired surrogate" }).meta({ "x-comb-text": "${STORABLE_TEXT_RULE}" })`,
		)
		expect(parse(write).safeParse("eleven char").success).toBe(false)
		expect(text('c.text("t", { email: true, max: 20 })', "update")).toBe(
			'z.string().trim().toLowerCase().meta({"x-comb-transform":["trim","lowercase"]}).check(z.email()).max(20)',
		)
	})
})

describe("stated", () => {
	it("names each bound given as x-comb meta, and is empty with none", () => {
		expect(stated({ maximum: 1, minimum: null })).toBe('.meta({"x-comb-maximum":1})')
		expect(stated({ maxLength: null })).toBe("")
	})
})

/* C1 of r18: comb's own bounds on a text, beside the declared ones, may leave no value: refused by the one effective range */
describe("textBase: a text's effective bounds that leave no value", () => {
	it.each([
		["a password's min past its 72", 'c.text("t", { password: true, min: 80 })', "min 80 and max 72"],
		[
			"a password's min past 72 under a wider declared max",
			'c.text("t", { password: true, min: 100, max: 200 })',
			"min 100 and max 72",
		],
		["a required text's max of 0", 'c.text("t", { max: 0 }).notNull()', "min 1 and max 0"],
		["a url shorter than https:// and a character", 'c.text("t", { url: true, max: 5 })', "min 9 and max 5"],
	])("fails codegen naming the column for %s", (_, raw, bounds) => {
		expect(() => text(raw, "create")).toThrow(`t: its length ${bounds} leave no value; widen them`)
	})

	it("takes a range that holds a value, comb's own bounds included, and a read of any", () => {
		expect(text('c.text("t", { password: true, min: 72 })', "create")).toContain(".min(72).max(72)")
		expect(text('c.text("t", { url: true, max: 9 })', "create")).toContain(".max(9)")
		expect(text('c.text("t", { max: 1 }).notNull()', "create")).toContain(".min(1).max(1)")
		expect(text('c.text("t", { max: 0 }).notNull()', "read")).toBe('z.string().meta({"x-comb-maxLength":0})')
	})
})

/** The transforms the JSON Schema of `code` publishes */
const transforms = (code: string) => z.toJSONSchema(parse(code), { io: "input" })["x-comb-transform"]

/* C2 of r18: a written text's transforms rewrite the value, so its schema publishes them, in order, from the one list that writes the chain */
describe("textBase: a written text's transforms", () => {
	it("publishes each one in the order the chain applies it", () => {
		expect(transforms(text('c.text("t", { trim: true, lowercase: true })', "create"))).toEqual(["trim", "lowercase"])
		expect(transforms(text('c.text("t", { uppercase: true })', "update"))).toEqual(["uppercase"])
		expect(transforms(text('c.text("t", { email: true })', "create"))).toEqual(["trim", "lowercase"])
	})

	it("publishes none on a text that takes none, or on a read", () => {
		expect(transforms(text('c.text("t", { max: 5 })', "create"))).toBeUndefined()
		expect(transforms(text('c.text("t", { trim: true })', "read"))).toBeUndefined()
		expect(transforms(text('c.text("t", { password: true, trim: true })', "create"))).toBeUndefined()
	})
})
