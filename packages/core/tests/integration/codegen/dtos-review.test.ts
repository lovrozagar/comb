/**
 * The 0.9.1 codegen review's DTO findings (F4–F6, F12, F13, F15, F16, F18), on generated schemas
 * run against real inputs: what each accepts and refuses, and what its JSON Schema publishes.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, type GeneratedEntity, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const keys = (schema: z.ZodObject | undefined) => Object.keys(schema?.shape ?? {}).sort()
const accepts = (schema: z.ZodObject | undefined, value: unknown) => (schema as z.ZodObject).safeParse(value).success

describe("timestamps on create (F4)", () => {
	it("leave created_at, updated_at and deleted_at out of the create body, whatever the casing", async () => {
		const dtos = await generatedDtos(
			"f4",
			`export const post = sqliteTable("post", { id: c.id("pst"), title: c.text("title").notNull(), created_at: c.createdAt(), updated_at: c.updatedAt(), deleted_at: c.deletedAt() })
export const visit = sqliteTable("visit", { id: c.id("vis"), note: c.text("note"), createdAt: c.createdAt("created_at"), updatedAt: c.updatedAt("updated_at") })`,
		)
		expect(keys(dtos["post"]?.["postDtoCreateSchema"])).toEqual(["title"])
		expect(keys(dtos["visit"]?.["visitDtoCreateSchema"])).toEqual(["note"])
		expect(
			accepts(dtos["post"]?.["postDtoReadSchema"], {
				created_at: 1,
				deleted_at: null,
				id: "p",
				title: "t",
				updated_at: 1,
			}),
		).toBe(true)
	})
})

describe("keys on create and read (F5, F6)", () => {
	let dtos: Record<string, GeneratedEntity>

	it("bound a text reference by its own declared bounds, not an id's (F5)", async () => {
		dtos = await generatedDtos(
			"f56",
			`export const page = sqliteTable("page", { id: c.id("pag"), slug: c.text("slug", { max: 200 }).notNull().unique() })
export const country = sqliteTable("country", { id: c.text("id").primaryKey(), name: c.text("name").notNull() })
export const visit = sqliteTable("visit", { id: c.id("vis"), pageSlug: c.text("page_slug", { max: 200 }).notNull().references(() => page.slug) })`,
		)
		const slug = "s".repeat(60)
		expect(accepts(dtos["visit"]?.["visitDtoCreateSchema"], { pageSlug: slug })).toBe(true)
		expect(accepts(dtos["visit"]?.["visitDtoReadSchema"], { id: "v", pageSlug: slug })).toBe(true)
		expect(accepts(dtos["visit"]?.["visitDtoCreateSchema"], { pageSlug: "s".repeat(201) })).toBe(false)
	})

	it("require a natural key named id on create, as nothing fills it (F6)", () => {
		expect(accepts(dtos["country"]?.["countryDtoCreateSchema"], { name: "Croatia" })).toBe(false)
		expect(accepts(dtos["country"]?.["countryDtoCreateSchema"], { id: "HR", name: "Croatia" })).toBe(true)
		expect(keys(dtos["page"]?.["pageDtoCreateSchema"])).toEqual(["slug"])
	})
})

describe("integers on Postgres, and NUL in its text and json (F12, F13)", () => {
	let dtos: Record<string, GeneratedEntity>

	it("clamp a declared bound to what int4 holds (F12)", async () => {
		dtos = await generatedDtos(
			"f1213",
			`import * as z from "zod"
export const dataSchema = z.object({ s: z.string() })
export const item = pgTable("item", { id: c.id("itm"), big: c.integer("big", { max: 5000000000 }), low: c.integer("low", { min: -5000000000 }), note: c.text("note"), data: c.json("data", dataSchema) })`,
			{ dialect: "postgres" },
		)
		const create = dtos["item"]?.["itemDtoCreateSchema"]
		expect(accepts(create, { big: 3_000_000_000 })).toBe(false)
		expect(accepts(create, { big: 2_147_483_647 })).toBe(true)
		expect(accepts(create, { low: -3_000_000_000 })).toBe(false)
	})

	it("refuse U+0000 in text and inside json strings, which Postgres refuses (F13)", () => {
		const create = dtos["item"]?.["itemDtoCreateSchema"]
		expect(accepts(create, { note: "a\u0000b" })).toBe(false)
		expect(accepts(create, { data: { s: "a\u0000b" } })).toBe(false)
		expect(accepts(create, { data: { s: "ab" }, note: "ab" })).toBe(true)
	})
})

describe("bounds, URL rules and examples (F15, F16, F18)", () => {
	let dtos: Record<string, GeneratedEntity>

	it("let a value read back be written back: an integer without min takes what its column holds (F15)", async () => {
		dtos = await generatedDtos(
			"f151618",
			`export const account = sqliteTable("account", {
	id: c.id("acc"),
	balance: c.integer("balance"),
	visits: c.integer("visits", { min: 0 }),
	avatar: c.text("avatar", { imageUri: true }),
	site: c.text("site", { url: true }),
	priority: c.integer("priority", { min: 100 }),
	code: c.text("code", { min: 10 }),
	sku: c.text("sku", { min: 50, max: 50 }),
	zip: c.text("zip", { pattern: "/^\\d{5}$/" }),
})`,
		)
		const account = dtos["account"] as GeneratedEntity
		expect(accepts(account["accountDtoReadPartialSchema"], { balance: -50, id: "a" })).toBe(true)
		expect(accepts(account["accountDtoUpdateSchema"], { balance: -50 })).toBe(true)
		expect(accepts(account["accountDtoCreateSchema"], { balance: -50 })).toBe(true)
		expect(accepts(account["accountDtoCreateSchema"], { visits: -1 })).toBe(false)
	})

	it("publish the image URI and https rules as patterns, so the JSON Schema refuses what the server does (F16)", () => {
		const json = z.toJSONSchema(dtos["account"]?.["accountDtoCreateSchema"] as z.ZodObject, { io: "input" }) as {
			properties: Record<string, { anyOf?: Array<{ pattern?: string }>; pattern?: string }>
		}
		const pattern = (name: string) =>
			json.properties[name]?.pattern ?? json.properties[name]?.anyOf?.find((each) => each.pattern)?.pattern
		expect(new RegExp(pattern("avatar") as string).test("ftp://x")).toBe(false)
		expect(new RegExp(pattern("avatar") as string).test("data:image/png;base64,x")).toBe(true)
		expect(new RegExp(pattern("site") as string).test("http://x.com")).toBe(false)
	})

	it("give examples the field's own rules accept, and none where a pattern decides (F18)", () => {
		const create = dtos["account"]?.["accountDtoCreateSchema"] as z.ZodObject
		const json = z.toJSONSchema(create, { io: "input" }) as {
			properties: Record<string, { anyOf?: Array<{ examples?: unknown[] }>; examples?: unknown[] }>
		}
		const examples = (name: string) =>
			json.properties[name]?.examples ?? json.properties[name]?.anyOf?.find((each) => each.examples)?.examples
		for (const name of ["priority", "code", "sku"]) {
			for (const example of examples(name) ?? [])
				expect(accepts(create, { [name]: example }), `${name} ${String(example)}`).toBe(true)
			expect(examples(name), name).toBeDefined()
		}
		expect(examples("zip")).toBeUndefined()
	})
})
