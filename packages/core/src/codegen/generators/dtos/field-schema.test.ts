import { pgTable } from "drizzle-orm/pg-core"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseField } from "../../__fixtures__/runtime.ts"
import { c as pgC } from "../../../pg/columns.ts"
import { c } from "../../../sqlite/columns.ts"
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema as generated } from "./field-schema.ts"

/* every written text and JSON field ends with the F11 rule; the tests below read the other rules, and
 * "the rule no engine stores" reads this one */
const TEXT_RULE =
	'.refine(isStorableText, { message: "Must not contain U+0000 or an unpaired surrogate" }).meta({ "x-comb-text": "no U+0000 or unpaired surrogate" })'
const JSON_RULE =
	'.refine((val) => !/\\\\u(?:0000|d[89a-f])/i.test(JSON.stringify(val ?? null).replace(/\\\\\\\\/g, "")), { message: "Must not contain U+0000 or an unpaired surrogate" })'
const generateFieldSchema = (...args: Parameters<typeof generated>) =>
	generated(...args)
		?.replace(TEXT_RULE, "")
		.replace(JSON_RULE, "") ?? null

const imports = (): ImportsMeta => ({
	enumImports: new Map(),

	identifiers: new Map(),
	jsonSchemaImports: new Set(),
})

function schema(name: string, raw: string, type: SchemaType) {
	return generateFieldSchema(parseField(name, raw), type, { imports: imports() })
}

/* the tables the references below point at */
const scope = {
	page: sqliteTable("page", { slug: c.text("slug", { max: 200 }) }),
	user: sqliteTable("user", { email: text("email"), id: c.id("usr") }),
}

/** A read field with what the test pins over it */
function fieldOf(name: string, raw: string, overrides: Partial<FieldMeta>): FieldMeta {
	return { ...parseField(name, raw, { scope }), ...overrides }
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

	it("gives an integer reference an integer schema, and a text one its own text rules (D5, F5)", () => {
		const fk = { column: "teamId", refColumn: "id", refTable: "team" }
		const team = fieldOf("teamId", 'c.integer("team_id").notNull().references(() => team.id)', { foreignKey: fk })
		expect(generateFieldSchema(team, "create", { imports: imports() })).toMatch(
			/^z\.number\(\)\.int\(\)\.min\(Number\.MIN_SAFE_INTEGER\)/,
		)
		expect(generateFieldSchema(team, "read", { imports: imports() })).toMatch(/^z\.number\(\)\.int\(\)/)
		expect(generateFieldSchema(team, "update", { imports: imports() })).toMatch(/^z\.number\(\)\.int\(\)/)
		/* a text reference to a c.id key takes the id bounds; to any other column, its own (F5, F10) */
		const owner = fieldOf("ownerId", 'c.text("owner_id").notNull().references(() => user.id)', {
			foreignKey: { ...fk, toId: true },
		})
		expect(generateFieldSchema(owner, "create", { imports: imports() })).toBe("z.string().regex(/^\\S{1,48}$/)")
		const named = fieldOf("ownerId", 'c.text("owner_id").notNull().references(() => user.email)', { foreignKey: fk })
		expect(generateFieldSchema(named, "create", { imports: imports() })).toBe("z.string().min(1)")
		const slug = fieldOf("pageSlug", 'c.text("page_slug", { max: 200 }).notNull().references(() => page.slug)', {
			foreignKey: { column: "pageSlug", refColumn: "slug", refTable: "page" },
		})
		expect(generateFieldSchema(slug, "create", { imports: imports() })).toBe("z.string().min(1).max(200)")
	})

	/* whether a reference enters the update DTO is isExcludedFromUpdate's (entity-meta.ts); this renders its rules */
	it("renders a reference's rules for every schema type: a c.ref that names no target, the id rules", () => {
		expect(schema("owner_id", 'c.ref("owner_id")', "update")).toBe(
			"z.string().regex(/^\\S{1,48}$/).nullable().optional()",
		)
		expect(schema("owner_id", 'c.ref("owner_id")', "create")).toBe(
			"z.string().regex(/^\\S{1,48}$/).nullable().optional()",
		)
		expect(schema("owner_id", 'c.ref("owner_id")', "read")).toBe(
			'z.string().meta({"x-comb-maxLength":48,"x-comb-minLength":1}).nullable()',
		)
	})
})

describe("generateFieldSchema: optionality", () => {
	it("requires what is not null on read and create, and takes no empty one on update", () => {
		expect(schema("title", 'c.text("title").notNull()', "read")).toBe("z.string().meta(_m.string)")
		expect(schema("title", 'c.text("title").notNull()', "readPartial")).toBe("z.string().meta(_m.string).optional()")
		expect(schema("title", 'c.text("title").notNull()', "create")).toBe("z.string().min(1).meta(_m.string)")
		expect(schema("title", 'c.text("title").notNull()', "update")).toBe("z.string().min(1).meta(_m.string).optional()")
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
			expect(generateFieldSchema(id, type, { imports: imports() })).toBeNull()
			expect(generateFieldSchema(serial, type, { imports: imports() })).toBeNull()
			expect(schema("created_at", 'c.createdAt("created_at")', type)).toBeNull()
			expect(schema("code", 'c.text("code", { autogenerate: true }).notNull()', type)).toBeNull()
		}
		expect(generateFieldSchema(id, "read", { imports: imports() })).not.toBeNull()
		expect(schema("created_at", 'c.createdAt("created_at")', "read")).toBe("timestampSchema")
		/* a natural key the caller supplies stays in create */
		const natural = fieldOf("code", 'c.text("code").primaryKey()', { isPrimaryKey: true })
		expect(generateFieldSchema(natural, "create", { imports: imports() })).not.toBeNull()
	})
})

describe("generateFieldSchema: kinds", () => {
	it("writes an enum from the values it holds at runtime, inline or through a const", () => {
		expect(schema("s", 'c.enum("s", ["a", "b"]).notNull()', "read")).toBe('z.enum(["a","b"]).meta({ examples: ["a"] })')
		const roles = parseField("s", 'c.enum("s", ROLES).notNull()', { scope: { ROLES: ["admin", "member"] } })
		expect(generateFieldSchema(roles, "read", { imports: imports() })).toBe(
			'z.enum(["admin","member"]).meta({ examples: ["admin"] })',
		)
	})
})

describe("generateFieldSchema: JSON", () => {
	it("validates JSON with its schema and caps its size on writes", () => {
		expect(
			generateFieldSchema(fieldOf("p", 'c.json("p", prefs)', { jsonSchemaName: "prefs" }), "read", {
				imports: imports(),
			}),
		).toBe("prefs.nullable()")
		expect(
			generateFieldSchema(
				fieldOf("p", 'c.json("p", prefs, { maxBytes: 100 })', { jsonSchemaName: "prefs" }),
				"create",
				{ imports: imports() },
			),
		).toContain("new TextEncoder().encode(JSON.stringify(val)).length <= 100")
		expect(() => schema("p", 'c.json("p")', "read")).toThrow(
			"fixture.p: no module of the project exports the schema its c.json is given",
		)
	})

	it("builds text from its annotations: kind, transforms, then bounds", () => {
		expect(schema("pw", 'c.text("pw", { password: true }).notNull()', "create")).toBe(
			"z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/)",
		)
		expect(schema("e", 'c.text("e", { email: true, min: 3, max: 50 }).notNull()', "create")).toBe(
			"z.string().trim().toLowerCase().check(z.email()).min(3).max(50).meta(_m.email)",
		)
		expect(
			generateFieldSchema(fieldOf("e", 'c.text("e", { email: true }, 80).notNull()', { length: 80 }), "read", {
				imports: imports(),
			}),
		).toBe('z.string().meta({"x-comb-maxLength":80}).meta(_m.email)')
		expect(schema("u", 'c.text("u", { url: true }).notNull()', "create")).toBe(
			'z.url().regex(/^https:\\/\\//, { message: "Must be an HTTPS URL" }).meta({ format: "uri" }).meta(_m.url)',
		)
		expect(schema("n", 'c.text("n", { trim: true, lowercase: true, max: 20 }).notNull()', "update")).toBe(
			"z.string().trim().toLowerCase().min(1).max(20).meta(_m.string).optional()",
		)
		expect(schema("n", 'c.text("n", { uppercase: true, pattern: "/^[A-Z]+$/" }).notNull()', "create")).toBe(
			/* a pattern decides what the value looks like, so it gets no example (F18) */
			"z.string().toUpperCase().min(1).regex(/^[A-Z]+$/)",
		)
		expect(
			generateFieldSchema(fieldOf("n", 'c.text("n", { min: 2 }, 10).notNull()', { length: 10 }), "read", {
				imports: imports(),
			}),
		).toBe('z.string().meta({"x-comb-maxLength":10,"x-comb-minLength":2}).meta(_m.string)')
	})
})

describe("generateFieldSchema: ids, typed text and numbers", () => {
	it("bounds an id-like text column, by helper and never by name", () => {
		/* read, comb's id length is stated: an imported or older id may not keep to it (F65) */
		expect(schema("id", 'c.id("usr")', "read")).toContain(
			'z.string().meta({"x-comb-maxLength":48,"x-comb-minLength":1})',
		)
		/* a text column named orgId is text (F10) */
		expect(schema("orgId", 'c.text("orgId").notNull()', "create")).toBe("z.string().min(1).meta(_m.string)")
	})

	it("writes numbers, timestamps and booleans", () => {
		/* written and read alike, so what is read back can be sent back (F15) */
		for (const type of ["read", "readPartial", "create", "update"] as const)
			expect(schema("n", 'c.integer("n").notNull()', type)).toMatch(
				/^z\.number\(\)\.int\(\)\.min\(Number\.MIN_SAFE_INTEGER\)\.max\(Number\.MAX_SAFE_INTEGER\)/,
			)
		expect(schema("n", 'c.integer("n", { min: 5 }).notNull()', "create")).toContain("z.number().int().min(5)")
		expect(schema("n", "c.serialId()", "read")).toBe(
			"z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).meta(_m.serialId)",
		)
		expect(schema("at", 'c.timestamp("at").notNull()', "read")).toBe(
			"z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).meta(_m.timestamp)",
		)
		expect(schema("at", 'c.createdAt("at")', "read")).toBe("timestampSchema")
		expect(schema("b", 'c.boolean("b").notNull()', "read")).toBe("z.boolean().meta(_m.boolean)")
		expect(schema("r", 'c.real("r").notNull()', "read")).toBe(
			'z.union([z.number(), z.literal([Infinity, -Infinity]).meta({ enum: undefined, type: "null" })]).meta(_m.real)',
		)
		/* a plain drizzle column is typed from its data type: a JSON blob takes any JSON value */
		expect(schema("x", 'blob("x")', "read")).toBe("z.json().nullable()")
		/* written, it takes the refine with its rule as meta, no $ref to keep plain (F63) */
		expect(schema("x", 'blob("x")', "create")).toBe(
			'z.json().meta({ "x-comb-text": "no U+0000 or unpaired surrogate" }).nullable().optional()',
		)
		expect(() => schema("x", 'blob("x", { mode: "buffer" })', "read")).toThrow(
			"fixture.x: comb has no rule for a SQLiteBlobBuffer column (object buffer)",
		)
	})

	it("enforces every declared numeric bound on a write and states it on a read (REVIEW 3.2, F65)", () => {
		expect(schema("t", 'c.integer("t", { min: -40, max: 60 }).notNull()', "create")).toMatch(
			/^z\.number\(\)\.int\(\)\.min\(-40\)\.max\(60\)/,
		)
		expect(schema("t", 'c.integer("t", { min: -40, max: 60 }).notNull()', "read")).toMatch(
			/^z\.number\(\)\.int\(\)\.min\(Number\.MIN_SAFE_INTEGER\)\.max\(Number\.MAX_SAFE_INTEGER\)\.meta\(\{"x-comb-maximum":60,"x-comb-minimum":-40\}\)/,
		)
		expect(schema("c", 'c.integer("c", { max: 9 }).notNull()', "create")).toMatch(
			/^z\.number\(\)\.int\(\)\.min\(Number\.MIN_SAFE_INTEGER\)\.max\(9\)/,
		)
		expect(schema("l", 'c.real("l", { min: -90.5, max: 90.5 }).notNull()', "create")).toMatch(
			/^z\.number\(\)\.min\(-90\.5\)\.max\(90\.5\)/,
		)
		expect(schema("d", 'c.real("d", { min: -0.25 }).notNull()', "create")).toMatch(
			/^z\.number\(\)\.min\(-0\.25\)\.meta/,
		)
		expect(schema("r", 'c.real("r", { max: 1.5 }).notNull()', "read")).toMatch(
			/^z\.union\(\[z\.number\(\), z\.literal\(\[Infinity, -Infinity\]\)\.meta\(\{ enum: undefined, type: "null" \}\)\]\)\.meta\(\{"x-comb-maximum":1\.5\}\)\.meta/,
		)
	})
})

describe("generateFieldSchema: what the 0.8.0 codegen review found (F1, F2, F15, F16)", () => {
	it("reads a stored password hash as a plain string, and checks the password rules only on writes (F1)", () => {
		expect(schema("pw", 'c.text("pw", { password: true }).notNull()', "read")).toBe("z.string()")
		expect(schema("pw", 'c.text("pw", { password: true }).notNull()', "update")).toBe(
			"z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/).optional()",
		)
	})

	it("refuses an empty string for a required text column on update as on create (F2)", () => {
		expect(schema("name", 'c.text("name").notNull()', "update")).toBe("z.string().min(1).meta(_m.string).optional()")
		expect(schema("name", 'c.text("name").notNull()', "read")).toBe("z.string().meta(_m.string)")
	})

	it("normalizes an email before validating it, on create and update (F15)", () => {
		expect(schema("e", 'c.text("e", { email: true }).notNull()', "update")).toBe(
			"z.string().trim().toLowerCase().check(z.email()).meta(_m.email).optional()",
		)
	})

	it("keeps an id-like column's declared bounds, adding the id defaults only where it declares none (F16)", () => {
		expect(schema("externalId", 'c.text("external_id", { min: 10 })', "create")).toBe(
			'z.string().min(10).meta({ examples: ["a1b2c3d4e5"] }).nullable().optional()',
		)
		expect(schema("externalId", 'c.text("external_id", { max: 60 })', "read")).toBe(
			'z.string().meta({"x-comb-maxLength":60}).meta(_m.string).nullable()',
		)
	})
})

describe("generateFieldSchema: name and imageUri (F3)", () => {
	it("checks a name's characters and an image URI's scheme on writes, and reads either as a string", () => {
		expect(schema("n", 'c.text("n", { name: true }).notNull()', "create")).toBe(
			'z.string().min(1).regex(/^[\\p{L}\\p{M}\\p{N}\\p{Zs}\\p{P}]+$/u, { message: "Must be a name: letters, marks, numbers, spaces and punctuation" }).meta(_m.string)',
		)
		expect(schema("a", 'c.text("a", { imageUri: true })', "update")).toBe(
			'z.string().regex(/^(?:https:\\/\\/|data:image\\/)/, { message: "Must be an HTTPS URL or a data:image/ URI" }).meta({ examples: ["https://example.com/a.png"] }).nullable().optional()',
		)
		expect(schema("a", 'c.text("a", { imageUri: true })', "read")).toBe(
			'z.string().meta({ examples: ["https://example.com/a.png"] }).nullable()',
		)
	})
})

describe("generateFieldSchema on Postgres (F8)", () => {
	it("bounds c.integer to int4, which Postgres stores it in, a declared bound clamped to it (F12)", () => {
		const field = parseField("age", 'c.integer("age").notNull()')
		expect(generateFieldSchema(field, "create", { dialect: "postgres", imports: imports() })).toBe(
			"z.number().int().min(-2147483648).max(2147483647).meta(_m.integer)",
		)
		const big = parseField("big", 'c.integer("big", { min: -5000000000, max: 5000000000 }).notNull()')
		expect(generateFieldSchema(big, "update", { dialect: "postgres", imports: imports() })).toMatch(
			/^z\.number\(\)\.int\(\)\.min\(-2147483648\)\.max\(2147483647\)/,
		)
		expect(generateFieldSchema(field, "read", { dialect: "postgres", imports: imports() })).toBe(
			"z.number().int().min(-2147483648).max(2147483647).meta(_m.integer)",
		)
		expect(generateFieldSchema(field, "create", { imports: imports() })).toBe(
			"z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).meta(_m.integer)",
		)
	})
})

describe("generateFieldSchema: a key on create, by what fills it (F6)", () => {
	it("requires a natural key named id, and leaves SQLite's integer rowid key optional, as the engine fills it", () => {
		expect(schema("id", 'c.text("id").primaryKey()', "create")).not.toMatch(/\.optional\(\)$/)
		const rowid = parseField("id", 'integer("id").primaryKey()')
		expect(generateFieldSchema(rowid, "create", { imports: imports() })).toMatch(/\.optional\(\)$/)
		expect(generateFieldSchema(rowid, "create", { dialect: "postgres", imports: imports() })).not.toMatch(
			/\.optional\(\)$/,
		)
	})
})

describe("generateFieldSchema: a JSON column's rules, published (F26)", () => {
	it("names the byte limit and the U+0000 and surrogate rule in x- keys of the field's meta, on either dialect", () => {
		const blob = fieldOf("b", 'c.json("b", blobSchema, { maxBytes: 20 })', { jsonSchemaName: "blobSchema" })
		const pg = generateFieldSchema(blob, "create", { dialect: "postgres", imports: imports() })
		expect(pg).toContain('.meta({ "x-comb-text": "no U+0000 or unpaired surrogate", "x-comb-maxBytes": 20 })')
		const plain = fieldOf("b", 'c.json("b", blobSchema)', { jsonSchemaName: "blobSchema" })
		expect(generateFieldSchema(plain, "create", { dialect: "postgres", imports: imports() })).toContain(
			'.meta({ "x-comb-text": "no U+0000 or unpaired surrogate" })',
		)
		/* on SQLite too, which stores neither as sent (F11); the refined schema as a union's one option,
		 * so it publishes anyOf: [$ref] to it (F63) */
		expect(generateFieldSchema(plain, "create", { dialect: "sqlite", imports: imports() })).toBe(
			'z.union([blobSchema]).meta({ "x-comb-text": "no U+0000 or unpaired surrogate" }).nullable().optional()',
		)
	})
})

/** The read schema of a Postgres column written as `raw` */
const pg = (raw: string) =>
	generateFieldSchema(parseField("n", raw, { dialect: "postgres" }), "read", {
		dialect: "postgres",
		imports: imports(),
	})

describe("generateFieldSchema: a plain drizzle column, typed from its data type (F6)", () => {
	it("bounds an integer by what its Postgres type holds, and takes a boolean and a double as they are", () => {
		expect(pg('smallint("n").notNull()')).toBe("z.number().int().min(-32768).max(32767)")
		expect(pg('integer("n").notNull()')).toBe("z.number().int().min(-2147483648).max(2147483647)")
		expect(pg('bigint("n", { mode: "number" }).notNull()')).toBe(
			"z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)",
		)
		expect(pg('boolean("n").notNull()')).toBe("z.boolean()")
		expect(pg('doublePrecision("n").notNull()')).toBe(
			'z.union([z.number(), z.literal([Infinity, -Infinity]).meta({ enum: undefined, type: "null" })])',
		)
	})
})

/* the 0.12 review's F9: a column kind that read its declared constraints and dropped them */
describe("generateFieldSchema: what a reference, a password and an email declare (F9)", () => {
	const keyed = {
		country: sqliteTable("country", { code: c.text("code", { max: 64 }).primaryKey() }),
		user: sqliteTable("user", { id: c.id("usr") }),
	}
	const of = (name: string, raw: string, type: SchemaType) =>
		generateFieldSchema(parseField(name, raw, { scope: keyed }), type, { imports: imports() })

	it("gives a c.ref to a natural key its own text rules, and the id rules only to a c.id key", () => {
		const country =
			'c.ref("country_code", { max: 64, pattern: "/^[A-Z-]+$/" }).notNull().references(() => country.code)'
		expect(of("countryCode", country, "create")).toBe("z.string().min(1).max(64).regex(/^[A-Z-]+$/)")
		expect(of("countryCode", country, "read")).toBe('z.string().meta({"x-comb-maxLength":64})')
		expect(of("ownerId", 'c.ref("owner_id").notNull().references(() => user.id)', "create")).toBe(
			"z.string().regex(/^\\S{1,48}$/)",
		)
	})

	/* a ref to a table in another database, as a shard's user_id to core's user, names no target */
	it("gives a c.ref that names no target the id rules, unless it declares its own", () => {
		const write = of("userId", 'c.ref("user_id").notNull()', "create")
		expect(write).toBe("z.string().regex(/^\\S{1,48}$/)")
		expect(of("userId", 'c.ref("user_id").notNull()', "read")).toBe(
			'z.string().meta({"x-comb-maxLength":48,"x-comb-minLength":1})',
		)
		const parse = new Function("z", `return ${write}`)(z) as z.ZodString
		expect(parse.safeParse("u".repeat(48)).success).toBe(true)
		expect(parse.safeParse("u".repeat(49)).success).toBe(false)
		expect(parse.safeParse("usr 01").success).toBe(false)
		expect(of("userId", 'c.ref("user_id", { max: 20 }).notNull()', "create")).toBe("z.string().min(1).max(20)")
		expect(of("userId", 'c.ref("user_id", { max: 20 }).notNull()', "read")).toBe(
			'z.string().meta({"x-comb-maxLength":20})',
		)
	})

	it("refuses U+0000 in a Postgres c.ref, as in its text", () => {
		const pgKeyed = { country: pgTable("country", { code: pgC.text("code").primaryKey() }) }
		const field = parseField("countryCode", 'c.ref("country_code").notNull().references(() => country.code)', {
			dialect: "postgres",
			scope: pgKeyed,
		})
		expect(generated(field, "create", { dialect: "postgres", imports: imports() })).toContain(TEXT_RULE)
	})

	it("applies a password's declared bounds and pattern on top of its own rule, and an email's pattern after the format", () => {
		expect(of("pw", 'c.text("pw", { password: true, min: 12, pattern: "/\\\\d/" }).notNull()', "create")).toBe(
			"z.string().min(12).max(72).regex(/^[\\x20-\\x7E]+$/).regex(/\\d/)",
		)
		expect(of("pw", 'c.text("pw", { password: true, max: 200 }).notNull()', "create")).toBe(
			"z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/)",
		)
		expect(of("m", 'c.text("m", { email: true, pattern: "/@corp\\\\.io$/" }).notNull()', "create")).toBe(
			/* a pattern decides what the value looks like, so it gets no example (F18) */
			"z.string().trim().toLowerCase().check(z.email()).regex(/@corp\\.io$/)",
		)
		expect(of("m", 'c.text("m", { email: true, pattern: "/@corp\\\\.io$/" }).notNull()', "read")).toBe("z.string()")
	})
})

/* the 0.12 review's F11: no engine stores U+0000 or a lone surrogate as sent */
describe("generateFieldSchema: the rule no engine stores", () => {
	it("ends every written text and JSON field, on both dialects, and no read one", () => {
		for (const dialect of ["sqlite", "postgres"] as const) {
			const textField = parseField("n", 'c.text("n")', { dialect })
			expect(generated(textField, "create", { dialect, imports: imports() })).toBe(
				`z.string()${TEXT_RULE}.meta(_m.string).nullable().optional()`,
			)
			expect(generated(textField, "read", { dialect, imports: imports() })).not.toContain(TEXT_RULE)
			const json = { ...parseField("b", 'c.json("b", blobSchema)', { dialect }), jsonSchemaName: "blobSchema" }
			expect(generated(json, "update", { dialect, imports: imports() })).toContain(JSON_RULE)
		}
	})
})

/** The schema of a Postgres column `a` written as `raw` */
const array = (raw: string, type: SchemaType) =>
	generateFieldSchema(parseField("a", raw, { dialect: "postgres" }), type, { dialect: "postgres", imports: imports() })

/*
 * F49 of the 0.13.0 round: a Postgres array is its element in an array per declared dimension on a
 * write, rectangular past one, and in any depth Postgres holds on a read; each element nullable
 */
describe("generateFieldSchema: a Postgres array column (F49)", () => {
	it("writes its element, nullable and with no min(1), in an array per dimension, and no example", () => {
		expect(array('text("a").array().notNull()', "create")).toBe("z.array(z.string().nullable())")
		expect(array('integer("a").array("[][]")', "update")).toMatch(
			/^z\.array\(z\.array\(z\.number\(\)\.int\(\)\.min\(-2147483648\)\.max\(2147483647\)\.nullable\(\)\)\)\.refine\(/,
		)
	})

	it("refuses a ragged multidimensional value, which Postgres refuses, and takes a rectangular one", () => {
		/* the generated refine is TypeScript, typed for a consumer's noImplicitAny */
		const code = ts.transpile(`return ${array('integer("a").array("[][][]").notNull()', "create")}`)
		const write = new Function("z", code)(z) as z.ZodType
		expect(write.safeParse([[[1, 2]], [[3, 4]]]).success).toBe(true)
		expect(write.safeParse([[[1, 2]], [[3]]]).success).toBe(false)
		expect(write.safeParse([[[1]], [[2], [3]]]).success).toBe(false)
		expect(write.safeParse([]).success).toBe(true)
	})

	it("takes a FieldMeta without dimensions, as a consumer may build one, for a column of one value", () => {
		const field = parseField("n", 'c.text("n")')
		const bare = { ...field, dimensions: undefined }
		expect(generateFieldSchema(bare, "create", { imports: imports() })).toBe(
			generateFieldSchema(field, "create", { imports: imports() }),
		)
	})

	it("reads any depth up to Postgres's six, as it keeps no declared dimensions", () => {
		const read = new Function("z", `return ${array('text("a").array().notNull()', "read")}`)(z) as z.ZodType
		expect(read.safeParse(["a", null]).success).toBe(true)
		expect(read.safeParse([[[[[["deep"]]]]]]).success).toBe(true)
		expect(read.safeParse([[[[[[["seven"]]]]]]]).success).toBe(false)
		expect(read.safeParse("a").success).toBe(false)
	})
})

/* F8 of the 0.14.1 review: a write DTO of bounds no integer meets refuses every value */
describe("generateFieldSchema: an integer's bounds that leave no integer", () => {
	it("fails codegen naming the column, whether the bounds hold no integer or none the column holds", () => {
		expect(() => schema("n", 'c.integer("n", { min: 1.5, max: 1.7 })', "create")).toThrow(
			"n: its bounds min 1.5 and max 1.7 leave no integer the column holds; widen them",
		)
		expect(() => schema("n", 'c.integer("n", { min: 9007199254740992 })', "create")).toThrow(
			"n: its bounds min 9007199254740992 and max 9007199254740991 leave no integer the column holds; widen them",
		)
	})

	it("takes bounds with an integer between them, a fractional one included", () => {
		expect(schema("n", 'c.integer("n", { min: 1.5, max: 2.5 })', "create")).toMatch(
			/^z\.number\(\)\.int\(\)\.min\(1\.5\)\.max\(2\.5\)/,
		)
	})
})
