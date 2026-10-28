import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseField } from "../../__fixtures__/runtime.ts"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"
import { pgWriteRule } from "./pg-types.ts"

const imports = (): ImportsMeta => ({ enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() })

/** The schema a Postgres column written as `source` gets in a `type` DTO */
const pgSchema = (source: string, type: SchemaType) =>
	generateFieldSchema(parseField("v", source, { dialect: "postgres" }), type, {
		dialect: "postgres",
		imports: imports(),
	})

/** The write rule of a Postgres column written as `source` */
const rule = (source: string) => pgWriteRule(parseField("v", source, { dialect: "postgres" }))

describe("pgWriteRule: a plain Postgres column's write rule by its data type (F50)", () => {
	it("gives the date and time types their ISO rule, a time with a zone its offset", () => {
		expect(rule('date("v")')).toBe("z.iso.date()")
		/* each keeps the instant: a timestamp only a local time, a timestamptz only one with its offset */
		expect(rule('timestamp("v", { mode: "string" })')).toMatch(/^z\.iso\.datetime\(\{ local: true \}\)\.regex\(/)
		expect(rule('timestamp("v", { mode: "string", withTimezone: true, precision: 3 })')).toBe(
			"z.iso.datetime({ offset: true })",
		)
		expect(rule('time("v")')).toBe("z.iso.time()")
		expect(rule('time("v", { withTimezone: true })')).toMatch(/^z\.string\(\)\.regex\(.*\(\?:Z\|\[\+-\]/)
		expect(rule('text("v")')).toBeUndefined()
	})

	/* the shapes the Postgres suite leaves out, evaluated as the generated DTO evaluates them */
	it("bounds a numeric by its own precision and scale, a fraction-only one at 0 before the point", () => {
		const check = (source: string) => new Function("z", `return ${rule(source)}`)(z) as z.ZodType
		const fractionOnly = check('numeric("v", { precision: 2, scale: 2 })')
		expect(["0.99", "-0.5", "0", ".5", "1.0", "0.123"].map((v) => fractionOnly.safeParse(v).success)).toEqual([
			true,
			true,
			true,
			false,
			false,
			false,
		])
		expect(rule('numeric("v", { mode: "number" })')).toBeUndefined()
		expect(check('numeric("v", { mode: "number", precision: 3 })').safeParse(999.4).success).toBe(true)
		expect(check('numeric("v", { mode: "number", precision: 3 })').safeParse(999.5).success).toBe(false)
	})

	/* F50: a Postgres data type with no rule is refused, never typed as plain text, naming what comb types */
	it("refuses a Postgres type comb has no rule for, listing the ones it types", () => {
		expect(() => rule('sparsevec("v", { dimensions: 3 })')).toThrow(
			/fixture\.v: comb has no rule for a PgSparseVector column \(string sparsevec\); build it with a c helper, or as drizzle text, varchar, char, uuid, .*inet, cidr, macaddr, macaddr8, bit/,
		)
		expect(rule('bit("v", { dimensions: 3 })')).toBe(
			'z.string().regex(/^[01]{3}$/, { message: "Must be exactly 3 bits" })',
		)
	})

	it("is the create and update DTOs' rule, and a read keeps the plain type", () => {
		expect(pgSchema('date("v").notNull()', "create")).toBe("z.iso.date()")
		expect(pgSchema('date("v")', "update")).toBe("z.iso.date().nullable().optional()")
		for (const type of ["read", "readPartial"] as const)
			expect(pgSchema('date("v").notNull()', type)).not.toContain("z.iso")
	})

	it("leaves a SQLite column and a c helper's column to their own rules", () => {
		const sqlite = parseField("v", 'text("v")')
		expect(generateFieldSchema({ ...sqlite, dataType: "string date" }, "create", { imports: imports() })).not.toContain(
			"z.iso",
		)
		expect(pgSchema('c.text("v")', "create")).not.toContain("z.iso")
	})
})
