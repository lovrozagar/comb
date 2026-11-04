/**
 * The 0.12 codegen review's F25, as A2-8 of r22 revised it: a url column publishes its https pattern
 * and no `format: "uri"`. z.url() checks by the WHATWG parser, which takes an IDN or a space in a path
 * that RFC 3986's grammar refuses, so a reader checking that format refused values the server stores.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

describe("a url column's published schema (F25, A2-8 of r22)", () => {
	it("publishes its https pattern and no format, and takes what the WHATWG parser takes", async () => {
		const dtos = await generatedDtos(
			"f25",
			`export const site = sqliteTable("site", { id: c.id("sit"), home: c.text("home", { url: true }).notNull() })`,
		)
		const create = dtos["site"]?.["siteDtoCreateSchema"] as z.ZodObject
		const home = (z.toJSONSchema(create, { io: "input" }) as { properties: Record<string, Record<string, unknown>> })
			.properties["home"]
		expect(home).toMatchObject({ pattern: "^https:\\/\\/" })
		expect(home).not.toHaveProperty("format")
		expect(create.safeParse({ home: "https://" }).success).toBe(false)
		expect(create.safeParse({ home: "https://example.com" }).success).toBe(true)
		expect(create.safeParse({ home: "https://例え.jp" }).success).toBe(true)
	})
})
