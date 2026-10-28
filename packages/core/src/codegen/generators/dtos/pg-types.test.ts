import { describe, expect, it } from "vitest"
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
