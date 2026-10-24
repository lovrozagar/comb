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
		expect(JSON.stringify(z.toJSONSchema(create, { io: "input" }))).toContain("uD800")
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
