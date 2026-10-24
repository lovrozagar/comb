/** The 0.12 codegen review's F25: a url column publishes its URI format beside its https pattern */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

describe("a url column's published schema (F25)", () => {
	it("keeps format uri after the https pattern, so a client refuses what the server does", async () => {
		const dtos = await generatedDtos(
			"f25",
			`export const site = sqliteTable("site", { id: c.id("sit"), home: c.text("home", { url: true }).notNull() })`,
		)
		const create = dtos["site"]?.["siteDtoCreateSchema"] as z.ZodObject
		const home = (z.toJSONSchema(create, { io: "input" }) as { properties: Record<string, Record<string, unknown>> })
			.properties["home"]
		expect(home?.["format"]).toBe("uri")
		expect(create.safeParse({ home: "https://" }).success).toBe(false)
		expect(create.safeParse({ home: "https://example.com" }).success).toBe(true)
	})
})
