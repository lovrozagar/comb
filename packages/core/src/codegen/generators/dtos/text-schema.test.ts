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
			"z.string().trim().toLowerCase().check(z.email()).max(20)",
		)
	})
})

describe("stated", () => {
	it("names each bound given as x-comb meta, and is empty with none", () => {
		expect(stated({ maximum: 1, minimum: null })).toBe('.meta({"x-comb-maximum":1})')
		expect(stated({ maxLength: null })).toBe("")
	})
})
