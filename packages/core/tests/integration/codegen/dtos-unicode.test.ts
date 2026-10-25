/**
 * The 0.12 codegen review's F11: Postgres refuses a lone UTF-16 surrogate in jsonb and stores one in
 * text as U+FFFD, so a Postgres DTO refuses ill-formed text and JSON as it refuses U+0000
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"
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
 * `pattern`, and a c.json field stays a plain `$ref` to its schema, its description its own
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
				expect(published.properties["prefs"]).toEqual({ $ref: "#/$defs/Prefs", "x-comb-text": RULE })
				expect(published.properties["extra"]).toEqual({
					anyOf: [{ $ref: "#/$defs/Prefs", "x-comb-text": RULE }, { type: "null" }],
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
