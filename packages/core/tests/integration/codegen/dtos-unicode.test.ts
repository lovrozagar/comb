/**
 * The 0.12 codegen review's F11: Postgres refuses a lone UTF-16 surrogate in jsonb and stores one in
 * text as U+FFFD, so a Postgres DTO refuses ill-formed text and JSON as it refuses U+0000
 */
import fs from "node:fs"
import path from "node:path"
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDir, generatedDtos } from "../support/dtos.ts"
import { libsqlMemory } from "../support/libsql.ts"

afterAll(() => cleanGeneratedDtos())

describe("ill-formed UTF-16 on Postgres (F11)", () => {
	it("refuses a lone surrogate in text and in JSON, and takes a pair", async () => {
		const dtos = await generatedDtos(
			"f11",
			`import * as z from "zod"
export const dataSchema = z.object({ s: z.string() })
export const item = pgTable("item", { id: c.id("itm"), note: c.text("note"), data: c.json("data", dataSchema) })`,
			{ dialect: "postgres" },
		)
		const create = dtos["item"]?.["itemDtoCreateSchema"] as z.ZodObject
		for (const bad of ["a\ud800b", "a\udc00", "\ud83d"]) {
			expect(create.safeParse({ note: bad }).success).toBe(false)
			expect(create.safeParse({ data: { s: bad } }).success).toBe(false)
		}
		expect(create.safeParse({ data: { s: "a😀b" }, note: "a😀b" }).success).toBe(true)
		expect(create.safeParse({ note: "a\u0000b" }).success).toBe(false)
		/* the rule is a refine, which JSON Schema publishes as x-comb-text, never as a pattern (F56) */
		expect(JSON.stringify(z.toJSONSchema(create, { io: "input" }))).not.toContain("uD800")
	})
})

describe("ill-formed UTF-16 and U+0000 on SQLite (F11)", () => {
	it("refuses them in text and in JSON as on Postgres, and takes a pair", async () => {
		const dtos = await generatedDtos(
			"f11-sqlite",
			`import * as z from "zod"
export const dataSchema = z.object({ s: z.string() })
export const item = sqliteTable("item", { id: c.id("itm"), note: c.text("note"), data: c.json("data", dataSchema) })`,
		)
		const create = dtos["item"]?.["itemDtoCreateSchema"] as z.ZodObject
		for (const bad of ["a\ud800b", "a\udc00", "\ud83d", "a\u0000b"]) {
			expect(create.safeParse({ note: bad }).success).toBe(false)
			expect(create.safeParse({ data: { s: bad } }).success).toBe(false)
		}
		expect(create.safeParse({ data: { s: "a😀b" }, note: "a😀b" }).success).toBe(true)
	})

	it("is what libsql changes on the way through: U+0000 and a lone surrogate do not come back as sent", async () => {
		/* a driver that one day stores these faithfully makes this fail, and the rule can be revisited */
		const { client, close } = libsqlMemory()
		try {
			await client.execute("CREATE TABLE t (v TEXT)")
			for (const sent of ["a\u0000b", "a\ud800b"]) {
				await client.execute({ args: [sent], sql: "INSERT INTO t VALUES (?)" })
				const { rows } = await client.execute("SELECT v FROM t")
				expect(rows[0]?.["v"]).not.toBe(sent)
				await client.execute("DELETE FROM t")
			}
		} finally {
			close()
		}
	})
})

/*
 * F56 and F63 of the 0.13.0 round: the text guard is a refine, stated as `x-comb-text`, never a
 * pattern: Go's and Rust's regex engines refuse `\u` and a surrogate, a field's own pattern stays its
 * `pattern`, and a c.json field stays a `$ref` to its schema, its description its own
 */
describe("the text guard, published (F56, F63)", () => {
	const RULE = "no U+0000 or unpaired surrogate"
	for (const dialect of ["postgres", "sqlite"] as const) {
		it(`keeps a field's own pattern and a c.json $ref, and names the guard in x-comb-text, on ${dialect}`, async () => {
			const table = dialect === "postgres" ? "pgTable" : "sqliteTable"
			const dtos = await generatedDtos(
				`f56-${dialect}`,
				`import * as z from "zod"
export const prefsSchema = z.object({ theme: z.string() }).meta({ id: "Prefs", description: "The account's display preferences" })
export const page = ${table}("page", { id: c.id("pag"), slug: c.text("slug", { max: 40, pattern: "/^[a-z0-9-]+$/" }).notNull(), note: c.text("note"), prefs: c.json("prefs", prefsSchema).notNull(), extra: c.json("extra", prefsSchema) })`,
				{ dialect },
			)
			const create = dtos["page"]?.["pageDtoCreateSchema"] as z.ZodObject
			for (const io of ["input", "output"] as const) {
				const published = z.toJSONSchema(create, { io }) as {
					$defs: Record<string, { description?: string }>
					properties: Record<string, Record<string, unknown>>
				}
				expect(published.properties["slug"]).toMatchObject({ pattern: "^[a-z0-9-]+$", "x-comb-text": RULE })
				expect(published.properties["slug"]).not.toHaveProperty("allOf")
				expect(published.properties["prefs"]).toEqual({ anyOf: [{ $ref: "#/$defs/Prefs" }], "x-comb-text": RULE })
				expect(published.properties["extra"]).toEqual({
					anyOf: [{ anyOf: [{ $ref: "#/$defs/Prefs" }], "x-comb-text": RULE }, { type: "null" }],
				})
				expect(published.$defs["Prefs"]?.description).toBe("The account's display preferences")
				expect(JSON.stringify(published)).not.toMatch(/\\u|uD800|uDFFF/i)
			}
			const body = { prefs: { theme: "dark" }, slug: "a-b" }
			expect(create.safeParse(body).success).toBe(true)
			/* under u a pair is one code point outside the class: an emoji passes, a lone half does not */
			expect(create.safeParse({ ...body, note: "a😀b", prefs: { theme: "😀" } }).success).toBe(true)
			for (const bad of ["a\u0000", "a\ud800"]) {
				expect(create.safeParse({ ...body, note: bad }).success).toBe(false)
				expect(create.safeParse({ ...body, prefs: { theme: bad } }).success).toBe(false)
			}
		})
	}
})

/** The F48 tables on `table`, a pgTable or a sqliteTable */
const TABLES = (table: string) => `export const account = ${table}("account", { id: c.id("acc") })
export const plain = ${table}("plain", { id: c.id("pln"), ownerId: c.ref("owner_id").notNull().references(() => account.id), homeId: c.ref("home_id"), byText: c.text("by_text").notNull().references(() => account.id) })`

/*
 * F48 of the 0.13.0 round: a key reference takes the id rule, `^\S{1,48}$`, which U+0000 and either
 * half of a surrogate pair match, so it takes the text guard after it, as every written text does
 */
describe("a reference under the id rule (F48)", () => {
	const BODY = { byText: "acc_1", homeId: "hom_1", ownerId: "acc_1" }

	for (const dialect of ["postgres", "sqlite"] as const) {
		it(`refuses U+0000 and a lone surrogate in each, and takes an id, on ${dialect}`, async () => {
			const dtos = await generatedDtos(`f48-${dialect}`, TABLES(dialect === "postgres" ? "pgTable" : "sqliteTable"), {
				dialect,
			})
			const create = dtos["plain"]?.["plainDtoCreateSchema"] as z.ZodObject
			expect(create.safeParse(BODY).success).toBe(true)
			expect(create.safeParse({ ...BODY, ownerId: "acc_😀" }).success).toBe(true)
			for (const key of ["byText", "homeId", "ownerId"])
				for (const bad of ["acc_1\u0000", "acc_\ud800", "\udc00"])
					expect(create.safeParse({ ...BODY, [key]: bad }).success, `${key} ${JSON.stringify(bad)}`).toBe(false)
		})
	}

	it("stores no row for a NUL reference on SQLite with foreign keys off, which libsql would cut to a real id", async () => {
		const dtos = await generatedDtos("f48-store", TABLES("sqliteTable"))
		const create = dtos["plain"]?.["plainDtoCreateSchema"] as z.ZodObject
		const { client, close } = libsqlMemory()
		try {
			await client.executeMultiple(`PRAGMA foreign_keys = OFF;
CREATE TABLE plain (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, home_id TEXT, by_text TEXT NOT NULL);`)
			const body = { ...BODY, ownerId: "acc_1\u0000tail" }
			const parsed = create.safeParse(body)
			if (parsed.success)
				await client.execute({
					args: ["pln_1", body.ownerId, body.homeId, body.byText],
					sql: "INSERT INTO plain VALUES (?, ?, ?, ?)",
				})
			expect(parsed.success).toBe(false)
			expect((await client.execute("SELECT count(*) AS n FROM plain")).rows[0]?.["n"]).toBe(0)
		} finally {
			close()
		}
	})
})

/*
 * G1 of the 0.13.1 consumers review: the text guard has one source, comb's isStorableText, which
 * every generated file that holds text to it imports, where each inlined its own copy of the regex
 */
describe("the text guard's one source (G1)", () => {
	it("is comb's isStorableText, imported by each generated file that refines with it", async () => {
		const dtos = await generatedDtos(
			"g1",
			`export const note = sqliteTable("note", { id: c.id("not"), body: c.text("body").notNull(), title: c.text("title", { max: 80 }) })`,
		)
		const files = (fs.readdirSync(generatedDir("g1"), { recursive: true }) as string[])
			.filter((name) => name.endsWith(".gen.ts"))
			.map((name) => fs.readFileSync(path.join(generatedDir("g1"), name), "utf8"))
		const refining = files.filter((source) => source.includes(".refine(comb.isStorableText,"))
		expect(refining.length).toBeGreaterThan(0)
		/* under comb's namespace, which no c.json import can take (C2 of r17) */
		for (const source of refining) expect(source).toContain('import * as comb from "@lovrozagar/comb"')
		for (const source of files) expect(source).not.toContain("\\u0000\\uD800")
		const create = dtos["note"]?.["noteDtoCreateSchema"] as z.ZodObject
		expect(create.safeParse({ body: "a😀b" }).success).toBe(true)
		expect(create.safeParse({ body: "a\u0000b" }).success).toBe(false)
	})
})

/*
 * C2 of r17: generated code names comb's predicates under one namespace and the globals through
 * globalThis, so a c.json schema exported under one of their names is the user's alone
 */
describe("a c.json schema named as comb's predicate or a global the generated code calls (C2)", () => {
	it.each(["isStorableText", "isCidr", "TextEncoder", "JSON", "Number", "Infinity"])(
		"leaves comb's own %s to the generated code",
		async (name) => {
			const dtos = await generatedDtos(
				`c2-${name.toLowerCase()}`,
				`import * as z from "zod"
export const ${name} = z.object({ a: z.string() })
export const one = sqliteTable("one", { id: c.id("one"), title: c.text("title"), doc: c.json("doc", ${name}, { maxBytes: 100 }), n: c.integer("n"), r: c.real("r") })`,
			)
			const create = dtos["one"]?.["oneDtoCreateSchema"] as z.ZodObject
			expect(create.safeParse({ doc: { a: "x" }, n: 1, title: "hello" }).success).toBe(true)
			expect(create.safeParse({ title: "a\u0000b" }).success).toBe(false)
			expect(create.safeParse({ doc: { a: "x".repeat(200) } }).success).toBe(false)
		},
	)
})
