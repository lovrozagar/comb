import { describe, expect, it } from "vitest"
import { parseField } from "../../analyze-field.ts"
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"

const imports = (): ImportsMeta => ({ enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() })

function schema(name: string, raw: string, type: SchemaType, overrides: Partial<FieldMeta> = {}) {
	return generateFieldSchema({ ...parseField(name, raw), ...overrides }, type, imports())
}

describe("generateFieldSchema: what each schema type includes", () => {
	it("never reads a private column back, of any kind", () => {
		for (const raw of [
			'c.text("s", { private: true })',
			'c.integer("s", { private: true })',
			'c.ref("s", { private: true })',
		]) {
			expect(schema("s", raw, "read")).toBeNull()
			expect(schema("s", raw, "readPartial")).toBeNull()
			expect(schema("s", raw, "create")).not.toBeNull()
		}
		expect(schema("_hidden", 'c.boolean("_hidden")', "read")).toBeNull()
	})

	it("leaves a reference out of the update body", () => {
		expect(schema("owner_id", 'c.ref("owner_id")', "update")).toBeNull()
		expect(schema("owner_id", 'c.ref("owner_id")', "create")).toBe("z.string().min(1).max(48).nullable().optional()")
	})
})

describe("generateFieldSchema: optionality", () => {
	it("requires what is not null on read and create, and nothing on update", () => {
		expect(schema("title", 'c.text("title").notNull()', "read")).toBe("z.string().meta(_m.string)")
		expect(schema("title", 'c.text("title").notNull()', "readPartial")).toBe("z.string().meta(_m.string).optional()")
		expect(schema("title", 'c.text("title").notNull()', "create")).toBe("z.string().min(1).meta(_m.string)")
		expect(schema("title", 'c.text("title").notNull()', "update")).toBe("z.string().meta(_m.string).optional()")
		expect(schema("title", 'c.text("title")', "read")).toBe("z.string().meta(_m.string).nullable()")
	})

	it("makes a column the database fills optional on create (M-M1)", () => {
		expect(schema("status", 'c.text("status").notNull().default("draft")', "create")).toBe(
			"z.string().min(1).meta(_m.string).optional()",
		)
		expect(schema("token", 'c.text("token").notNull().$defaultFn(() => "x")', "create")).toMatch(/\.optional\(\)$/)
		expect(schema("on", 'c.boolean("on").notNull().default(true)', "create")).toBe(
			"z.boolean().meta(_m.boolean).optional()",
		)
		expect(schema("id", 'c.id("usr")', "create")).toMatch(/\.optional\(\)$/)
		expect(schema("created_at", 'c.createdAt("created_at")', "create")).toMatch(/\.optional\(\)$/)
		expect(schema("code", 'c.text("code", { autogenerate: true }).notNull()', "create")).toMatch(/\.optional\(\)$/)
	})
})

describe("generateFieldSchema: kinds", () => {
	it("writes an enum from its values or its imported name, and refuses one it cannot read", () => {
		expect(schema("s", 'c.enum("s", ["a", "b"]).notNull()', "read", { enumValues: ["a", "b"] })).toBe(
			'z.enum(["a","b"]).meta({ examples: ["a"] })',
		)
		expect(schema("s", 'c.enum("s", ROLES).notNull()', "read", { enumName: "ROLES" })).toBe(
			"z.enum(ROLES).meta(_m.string)",
		)
		expect(() => schema("s", 'c.enum("s", [a, b])', "read")).toThrow(
			'c.enum column "s": its values are not string literals',
		)
	})

	it("validates JSON with its schema and caps its size on writes", () => {
		expect(schema("p", 'c.json("p", prefs)', "read", { jsonSchemaName: "prefs" })).toBe("prefs.nullable()")
		expect(schema("p", 'c.json("p", prefs, { maxBytes: 100 })', "create", { jsonSchemaName: "prefs" })).toContain(
			"JSON.stringify(val).length <= 100",
		)
		expect(() => schema("p", 'c.json("p")', "read")).toThrow("c.json() must have schema as second parameter")
	})

	it("builds text from its annotations: kind, transforms, then bounds", () => {
		expect(schema("pw", 'c.text("pw", { password: true }).notNull()', "create")).toBe(
			"z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/)",
		)
		expect(schema("e", 'c.text("e", { email: true, min: 3, max: 50 }).notNull()', "create")).toBe(
			"z.email().trim().toLowerCase().min(3).max(50).meta(_m.email)",
		)
		expect(schema("e", 'c.text("e", { email: true }, 80).notNull()', "read", { length: 80 })).toBe(
			"z.email().max(80).meta(_m.email)",
		)
		expect(schema("u", 'c.text("u", { url: true }).notNull()', "create")).toBe(
			'z.url().refine((v) => /^https:\\/\\//.test(v), { message: "Must be an HTTPS URL" }).meta(_m.url)',
		)
		expect(schema("n", 'c.text("n", { trim: true, lowercase: true, max: 20 }).notNull()', "update")).toBe(
			"z.string().trim().toLowerCase().max(20).meta(_m.string).optional()",
		)
		expect(schema("n", 'c.text("n", { uppercase: true, pattern: /^[A-Z]+$/ }).notNull()', "create")).toBe(
			"z.string().toUpperCase().min(1).regex(/^[A-Z]+$/).meta(_m.string)",
		)
		expect(schema("n", 'c.text("n", { min: 2 }, 10).notNull()', "read", { length: 10 })).toBe(
			"z.string().min(2).max(10).meta(_m.string)",
		)
	})

	it("bounds an id-like text column, and uses a typed schema when the column names one", () => {
		expect(schema("id", 'c.id("usr")', "read")).toContain(".min(1).max(48)")
		expect(schema("orgId", 'c.text("orgId").notNull()', "create")).toBe(
			"z.string().regex(/^\\S{1,48}$/).meta(_m.string)",
		)
		const typed = generateFieldSchema(parseField("p", 'c.text("p").$type<z.infer<typeof prefs>>()'), "read", imports())
		expect(typed).toBe("prefs.nullable()")
		expect(schema("p", 'c.text("p").$type<string>()', "read")).toBe("z.string().meta(_m.string).nullable()")
	})

	it("writes numbers, timestamps and booleans", () => {
		expect(schema("n", 'c.integer("n").notNull()', "read")).toBe(
			"z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).meta(_m.integer)",
		)
		expect(schema("n", 'c.integer("n", { min: 5 }).notNull()', "read")).toContain("z.number().int().min(5)")
		expect(schema("n", "c.serialId()", "read")).toBe(
			"z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).meta(_m.serialId)",
		)
		expect(schema("at", 'c.timestamp("at").notNull()', "read")).toBe("timestampSchema")
		expect(schema("b", 'c.boolean("b").notNull()', "read")).toBe("z.boolean().meta(_m.boolean)")
		expect(schema("r", 'c.real("r").notNull()', "read")).toBe("z.number().meta(_m.real)")
		expect(schema("x", 'blob("x")', "read")).toBe("z.unknown().nullable()")
	})
})
