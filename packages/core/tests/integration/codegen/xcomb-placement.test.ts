/**
 * C4 of r19: every `x-comb-*` key sits on the property's own schema (`items` for an array element's),
 * beside the `anyOf` of a nullable field, so a reader finds it with no `anyOf` walk; a nullable
 * field's non-null member repeats them, and holds no other (C1 of r20).
 * The walk covers each DTO of a table holding every kind that publishes one.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const TABLE = `import { jsonb, text } from "drizzle-orm/pg-core"
import * as z from "zod"
export const Doc = z.object({ a: z.string() })
export const row = pgTable("row", {
	id: c.id("row"),
	title: c.text("title", { max: 50, min: 2, trim: true }),
	titled: c.text("titled", { max: 50, trim: true }).notNull(),
	mail: c.text("mail", { email: true, max: 90 }),
	site: c.text("site", { url: true }),
	label: c.text("label", { name: true }),
	ratio: c.real("ratio", { max: 1, min: 0 }),
	count: c.integer("count", { max: 9, min: 1 }),
	doc: c.json("doc", Doc, { maxBytes: 64 }),
	docs: c.json("docs", Doc).array(),
	raw: jsonb("raw"),
	rawn: jsonb("rawn").notNull(),
	tags: text("tags").array(),
	short: c.text("short", { max: 5 }).array(),
	shortReq: c.text("short_req", { max: 5 }).array().notNull(),
	nums: c.integer("nums", { max: 9, min: 1 }).array(),
	ratios: c.real("ratios", { max: 1, min: 0 }).array().notNull(),
})`

type Schema = { anyOf?: Schema[]; items?: Schema } & Record<string, unknown>

const xComb = (schema: Schema): string[] => Object.keys(schema).filter((key) => key.startsWith("x-comb-"))

/**
 * Each `x-comb-*` key inside an `anyOf` member of `schema` that `schema` itself does not carry with
 * the same value, by the path to it: a nullable field's member repeats the property's keys, so
 * `.unwrap()` keeps them (C1 of r20), and holds no other
 */
function misplaced(schema: Schema, at: string): string[] {
	const members = (schema.anyOf ?? []).flatMap((member, i) => [
		...xComb(member)
			.filter((key) => JSON.stringify(member[key]) !== JSON.stringify(schema[key]))
			.map((key) => `${at}.anyOf[${i}].${key}`),
		...misplaced(member, `${at}.anyOf[${i}]`),
	])
	return schema.items === undefined ? members : [...members, ...misplaced(schema.items, `${at}.items`)]
}

/** The JSON Schema of each of `row`'s DTOs */
async function documents(): Promise<Array<[string, { properties: Record<string, Schema> }]>> {
	const dtos = await generatedDtos("c4", TABLE, { dialect: "postgres" })
	const row = dtos["row"] as Record<string, z.ZodObject>
	return ["rowDtoCreateSchema", "rowDtoUpdateSchema", "rowDtoReadSchema"].map((name) => [
		name,
		z.toJSONSchema(row[name] as z.ZodObject, {
			io: name.endsWith("ReadSchema") ? "output" : "input",
			unrepresentable: "any",
		}) as never,
	])
}

describe("where a field's x-comb-* keys sit", () => {
	it("is never inside an anyOf member alone, in any DTO", async () => {
		for (const [name, { properties }] of await documents())
			expect(Object.entries(properties).flatMap(([key, schema]) => misplaced(schema, `${name}.${key}`))).toEqual([])
	})

	it("is the property's own schema, nullable or not, so a reader needs no walk", async () => {
		const [[, create], , [, read]] = (await documents()) as [
			[string, { properties: Record<string, Schema> }],
			unknown,
			[string, { properties: Record<string, Schema> }],
		]
		const facts = (schema: Schema | undefined) => xComb(schema as Schema).toSorted()
		expect(facts(create.properties["title"])).toEqual(["x-comb-text", "x-comb-transform"])
		expect(facts(create.properties["titled"])).toEqual(["x-comb-text", "x-comb-transform"])
		expect(facts(create.properties["mail"])).toEqual(["x-comb-transform"])
		expect(facts(create.properties["site"])).toEqual(["x-comb-text", "x-comb-transform"])
		expect(facts(create.properties["doc"])).toEqual(["x-comb-maxBytes", "x-comb-text"])
		expect(facts(create.properties["raw"])).toEqual(["x-comb-text"])
		expect(facts(read.properties["title"])).toEqual(["x-comb-maxLength", "x-comb-minLength"])
		expect(facts(read.properties["ratio"])).toEqual(["x-comb-maximum", "x-comb-minimum"])
		expect(facts(read.properties["count"])).toEqual(["x-comb-maximum", "x-comb-minimum"])
	})

	it("is `items` for an array element's rules", async () => {
		const [[, create]] = (await documents()) as Array<[string, { properties: Record<string, Schema> }]> as [
			[string, { properties: Record<string, Schema> }],
		]
		const items = (key: string) =>
			((create.properties[key] as Schema).anyOf as Schema[]).find(({ type }) => type === "array")?.items as Schema
		expect(xComb(items("tags"))).toEqual(["x-comb-text"])
		expect(xComb(items("docs"))).toEqual(["x-comb-text"])
	})
})
