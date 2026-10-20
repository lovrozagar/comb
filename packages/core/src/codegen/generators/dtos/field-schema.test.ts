import { describe, expect, it } from "vitest"
import { parseField } from "../../analyze-field.ts"
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"

const imports = (): ImportsMeta => ({
	enumImports: new Map(),
	identifierValues: new Map(),
	identifiers: new Map(),
	jsonSchemaImports: new Set(),
})

function schema(name: string, raw: string, type: SchemaType) {
	return generateFieldSchema(parseField(name, raw), type, imports())
}

/** A parsed field with what the analyzer would have filled in from elsewhere in the file */
function fieldOf(name: string, raw: string, overrides: Partial<FieldMeta>): FieldMeta {
	return { ...parseField(name, raw), ...overrides }
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

	it("gives an integer reference an integer schema, and a text one the id string (D5)", () => {
		const fk = { column: "teamId", refColumn: "id", refTable: "team" }
		const team = fieldOf("teamId", 'c.integer("team_id").notNull().references(() => team.id)', { foreignKey: fk })
		expect(generateFieldSchema(team, "create", imports())).toMatch(/^z\.number\(\)\.int\(\)\.nonnegative\(\)/)
		expect(generateFieldSchema(team, "read", imports())).toMatch(/^z\.number\(\)\.int\(\)/)
		expect(generateFieldSchema(team, "update", imports())).toBeNull()
		const owner = fieldOf("ownerId", 'c.text("owner_id").notNull().references(() => user.id)', { foreignKey: fk })
		expect(generateFieldSchema(owner, "create", imports())).toBe("z.string().min(1).max(48)")
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
	})

	it("leaves what comb or the database generates out of create and update (D9)", () => {
		const id = fieldOf("id", 'c.id("usr")', { isPrimaryKey: true })
		const serial = fieldOf("id", "c.serialId()", { isPrimaryKey: true })
		for (const type of ["create", "update"] as const) {
			expect(generateFieldSchema(id, type, imports())).toBeNull()
			expect(generateFieldSchema(serial, type, imports())).toBeNull()
			expect(schema("created_at", 'c.createdAt("created_at")', type)).toBeNull()
			expect(schema("code", 'c.text("code", { autogenerate: true }).notNull()', type)).toBeNull()
		}
		expect(generateFieldSchema(id, "read", imports())).not.toBeNull()
		expect(schema("created_at", 'c.createdAt("created_at")', "read")).toBe("timestampSchema")
		/* a natural key the caller supplies stays in create */
		const natural = fieldOf("code", 'c.text("code").primaryKey()', { isPrimaryKey: true })
		expect(generateFieldSchema(natural, "create", imports())).not.toBeNull()
	})
})

describe("generateFieldSchema: kinds", () => {
	it("writes an enum from its values or its imported name, and refuses one it cannot read", () => {
		expect(
			generateFieldSchema(
				fieldOf("s", 'c.enum("s", ["a", "b"]).notNull()', { enumValues: ["a", "b"] }),
				"read",
				imports(),
			),
		).toBe('z.enum(["a","b"]).meta({ examples: ["a"] })')
		expect(
			generateFieldSchema(fieldOf("s", 'c.enum("s", ROLES).notNull()', { enumName: "ROLES" }), "read", imports()),
		).toBe("z.enum(ROLES).meta(_m.string)")
		expect(() => schema("s", 'c.enum("s", [a, b])', "read")).toThrow(
			'c.enum column "s": its values are not string literals',
		)
	})

	it("validates JSON with its schema and caps its size on writes", () => {
		expect(
			generateFieldSchema(fieldOf("p", 'c.json("p", prefs)', { jsonSchemaName: "prefs" }), "read", imports()),
		).toBe("prefs.nullable()")
		expect(
			generateFieldSchema(
				fieldOf("p", 'c.json("p", prefs, { maxBytes: 100 })', { jsonSchemaName: "prefs" }),
				"create",
				imports(),
			),
		).toContain("new TextEncoder().encode(JSON.stringify(val)).length <= 100")
		expect(() => schema("p", 'c.json("p")', "read")).toThrow("c.json() must have schema as second parameter")
	})

	it("builds text from its annotations: kind, transforms, then bounds", () => {
		expect(schema("pw", 'c.text("pw", { password: true }).notNull()', "create")).toBe(
			"z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/)",
		)
		expect(schema("e", 'c.text("e", { email: true, min: 3, max: 50 }).notNull()', "create")).toBe(
			"z.email().trim().toLowerCase().min(3).max(50).meta(_m.email)",
		)
		expect(
			generateFieldSchema(
				fieldOf("e", 'c.text("e", { email: true }, 80).notNull()', { length: 80 }),
				"read",
				imports(),
			),
		).toBe("z.email().max(80).meta(_m.email)")
		expect(schema("u", 'c.text("u", { url: true }).notNull()', "create")).toBe(
			'z.url().refine((v) => /^https:\\/\\//.test(v), { message: "Must be an HTTPS URL" }).meta(_m.url)',
		)
		expect(schema("n", 'c.text("n", { trim: true, lowercase: true, max: 20 }).notNull()', "update")).toBe(
			"z.string().trim().toLowerCase().max(20).meta(_m.string).optional()",
		)
		expect(schema("n", 'c.text("n", { uppercase: true, pattern: /^[A-Z]+$/ }).notNull()', "create")).toBe(
			"z.string().toUpperCase().min(1).regex(/^[A-Z]+$/).meta(_m.string)",
		)
		expect(
			generateFieldSchema(fieldOf("n", 'c.text("n", { min: 2 }, 10).notNull()', { length: 10 }), "read", imports()),
		).toBe("z.string().min(2).max(10).meta(_m.string)")
	})
})

describe("generateFieldSchema: ids, typed text and numbers", () => {
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
			"z.number().int().max(Number.MAX_SAFE_INTEGER).meta(_m.integer)",
		)
		/* the non-negative floor guards writes; a read takes whatever the column holds (G-S2) */
		expect(schema("n", 'c.integer("n").notNull()', "readPartial")).toMatch(/^z\.number\(\)\.int\(\)\.max\(/)
		expect(schema("n", 'c.integer("n").notNull()', "create")).toMatch(/^z\.number\(\)\.int\(\)\.nonnegative\(\)/)
		expect(schema("n", 'c.integer("n").notNull()', "update")).toMatch(/^z\.number\(\)\.int\(\)\.nonnegative\(\)/)
		expect(schema("n", 'c.integer("n", { min: 5 }).notNull()', "read")).toContain("z.number().int().min(5)")
		expect(schema("n", "c.serialId()", "read")).toBe("z.number().int().max(Number.MAX_SAFE_INTEGER).meta(_m.serialId)")
		expect(schema("at", 'c.timestamp("at").notNull()', "read")).toBe("timestampSchema")
		expect(schema("b", 'c.boolean("b").notNull()', "read")).toBe("z.boolean().meta(_m.boolean)")
		expect(schema("r", 'c.real("r").notNull()', "read")).toBe("z.number().meta(_m.real)")
		expect(schema("x", 'blob("x")', "read")).toBe("z.unknown().nullable()")
	})

	it("carries every declared numeric bound (REVIEW 3.2)", () => {
		expect(schema("t", 'c.integer("t", { min: -40, max: 60 }).notNull()', "read")).toMatch(
			/^z\.number\(\)\.int\(\)\.min\(-40\)\.max\(60\)/,
		)
		expect(schema("c", 'c.integer("c", { max: 9 }).notNull()', "create")).toMatch(
			/^z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(9\)/,
		)
		expect(schema("l", 'c.real("l", { min: -90.5, max: 90.5 }).notNull()', "read")).toMatch(
			/^z\.number\(\)\.min\(-90\.5\)\.max\(90\.5\)/,
		)
		expect(schema("d", 'c.real("d", { min: -0.25 }).notNull()', "read")).toMatch(/^z\.number\(\)\.min\(-0\.25\)\.meta/)
		expect(schema("r", 'c.real("r", { max: 1.5 }).notNull()', "read")).toMatch(/^z\.number\(\)\.max\(1\.5\)\.meta/)
	})
})
