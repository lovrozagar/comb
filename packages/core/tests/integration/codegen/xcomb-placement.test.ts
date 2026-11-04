/**
 * C4 of r19: every `x-comb-*` key sits on the property's own schema (`items` for an array element's),
 * beside the `anyOf` of a nullable field, so a reader finds it with no `anyOf` walk; a nullable
 * field's non-null member repeats them, and holds no other (C1 of r20); every one of them, a written
 * JSON value's included (C2 of r21). No schema is a one-member `anyOf`, `oneOf` or `allOf`, a wrapper
 * every reader of the spec would have to flatten (C2a of the 0.20.0 G3).
 * The walk covers each DTO of a table holding every kind that publishes one.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const TABLE = `import { cidr, integer, json, jsonb, text } from "drizzle-orm/pg-core"
import * as z from "zod"
export const Doc = z.object({ a: z.string() })
export const Reg = z.object({ b: z.string() }).meta({ id: "XcombReg" })
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
	reg: c.json("reg", Reg),
	regReq: c.json("reg_req", Reg).notNull(),
	docReq: c.json("doc_req", Doc).notNull(),
	raw: jsonb("raw"),
	rawn: jsonb("rawn").notNull(),
	plain: json("plain"),
	tags: text("tags").array(),
	short: c.text("short", { max: 5 }).array(),
	shortReq: c.text("short_req", { max: 5 }).array().notNull(),
	nums: c.integer("nums", { max: 9, min: 1 }).array(),
	ratios: c.real("ratios", { max: 1, min: 0 }).array().notNull(),
	/* AA3 of area A's review: the keys a cidr and a multidimensional array publish, on nullable columns */
	net: cidr("net"),
	nets: cidr("nets").array(),
	grid: integer("grid").array("[][]"),
})`

/* SQLite's JSON kinds, for the wrapper walk: a c.json column, registered or not, and a drizzle JSON text */
const SQLITE_TABLE = `import { text } from "drizzle-orm/sqlite-core"
import * as z from "zod"
export const Doc = z.object({ a: z.string() })
export const Reg = z.object({ b: z.string() }).meta({ id: "XcombRegLite" })
export const row = sqliteTable("row", {
	id: c.id("row"),
	title: c.text("title", { max: 50, min: 2, trim: true }),
	doc: c.json("doc", Doc, { maxBytes: 64 }),
	docReq: c.json("doc_req", Doc).notNull(),
	reg: c.json("reg", Reg),
	raw: text("raw", { mode: "json" }),
})`

type Schema = { anyOf?: Schema[]; items?: Schema } & Record<string, unknown>

const xComb = (schema: Schema): string[] => Object.keys(schema).filter((key) => key.startsWith("x-comb-"))

/** Each level's element keys of an array `member` that the property's `items` at that level does not state */
function unstatedItems(member: Schema | undefined, property: Schema | undefined, at: string): string[] {
	const keys = Object.fromEntries(xComb(member ?? {}).map((key) => [key, member?.[key]]))
	const stated = Object.fromEntries(xComb(property ?? {}).map((key) => [key, property?.[key]]))
	const here = JSON.stringify(keys) === JSON.stringify(stated) ? [] : [`${at}: ${JSON.stringify(keys)}`]
	return member?.type === "array" ? [...here, ...unstatedItems(member.items, property?.items, `${at}.items`)] : here
}

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

/**
 * Each `x-comb-*` key of a nullable `schema` that one of its non-null members does not repeat with the
 * same value, by the path to the member: the reverse of `misplaced`, so `.unwrap()` keeps every key
 */
function unkept(schema: Schema, at: string): string[] {
	const members = schema.anyOf ?? []
	const nullable = members.some(({ type }) => type === "null")
	const missing = members.flatMap((member, i) =>
		nullable && member["type"] !== "null"
			? xComb(schema)
					.filter((key) => JSON.stringify(member[key]) !== JSON.stringify(schema[key]))
					.map((key) => `${at}.anyOf[${i}] lacks ${key}`)
			: [],
	)
	return schema.items === undefined ? missing : [...missing, ...unkept(schema.items, `${at}.items`)]
}

/**
 * Each `anyOf`, `oneOf` or `allOf` of one member anywhere in `node`, by the path to it: a wrapper
 * that says nothing its member does not, which a generator that does not flatten it types as any JSON
 */
function wrappers(node: unknown, at: string): string[] {
	if (Array.isArray(node)) return node.flatMap((child, i) => wrappers(child, `${at}[${i}]`))
	if (node === null || typeof node !== "object") return []
	return Object.entries(node).flatMap(([key, child]) => [
		...(["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(child) && child.length === 1
			? [`${at}.${key}`]
			: []),
		...wrappers(child, `${at}.${key}`),
	])
}

/** The JSON Schema of each of `row`'s DTOs */
async function documents(
	dialect: "postgres" | "sqlite" = "postgres",
): Promise<Array<[string, { properties: Record<string, Schema> }]>> {
	const dtos = await generatedDtos(`c4-${dialect}`, dialect === "postgres" ? TABLE : SQLITE_TABLE, { dialect })
	const row = dtos["row"] as Record<string, z.ZodObject>
	return ["rowDtoCreateSchema", "rowDtoUpdateSchema", "rowDtoReadSchema"].map((name) => [
		name,
		z.toJSONSchema(row[name] as z.ZodObject, {
			io: name.endsWith("ReadSchema") ? "output" : "input",
			unrepresentable: "any",
		}) as never,
	])
}

describe("a DTO's published schema (C2a of the 0.20.0 G3)", () => {
	it("holds no one-member anyOf, oneOf or allOf, on either dialect, a registered schema's included", async () => {
		for (const dialect of ["postgres", "sqlite"] as const)
			for (const [name, document] of await documents(dialect))
				expect(wrappers(document, `${dialect}.${name}`)).toEqual([])
	})

	it("publishes a nullable written JSON value as its schema beside null, the keys on the schema itself", async () => {
		const [[, create]] = (await documents()) as Array<[string, { properties: Record<string, Schema> }]> as [
			[string, { properties: Record<string, Schema> }],
		]
		expect(create.properties["doc"]).toEqual({
			anyOf: [
				expect.objectContaining({
					type: "object",
					"x-comb-maxBytes": 64,
					"x-comb-text": "no U+0000 or unpaired surrogate",
				}),
				{ type: "null" },
			],
			"x-comb-maxBytes": 64,
			"x-comb-text": "no U+0000 or unpaired surrogate",
		})
		/* a registered schema is its $ref with the keys beside it, its body published once under its id */
		expect(create.properties["reg"]?.anyOf?.[0]).toEqual({
			$ref: expect.stringContaining("XcombReg"),
			"x-comb-text": "no U+0000 or unpaired surrogate",
		})
		expect(create.properties["regReq"]).toEqual({
			$ref: expect.stringContaining("XcombReg"),
			"x-comb-text": "no U+0000 or unpaired surrogate",
		})
	})
})

describe("where a field's x-comb-* keys sit", () => {
	it("is never inside an anyOf member alone, in any DTO", async () => {
		for (const [name, { properties }] of await documents())
			expect(Object.entries(properties).flatMap(([key, schema]) => misplaced(schema, `${name}.${key}`))).toEqual([])
	})

	it("is on a nullable field's non-null member too, every key of it, in any DTO (C2 of r21)", async () => {
		for (const [name, { properties }] of await documents())
			expect(Object.entries(properties).flatMap(([key, schema]) => unkept(schema, `${name}.${key}`))).toEqual([])
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
		expect(facts(create.properties["plain"])).toEqual(["x-comb-text"])
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

	/* A2-6 of r22: a nullable array's element keys on the property's own `items` too, as §2.1 reads them */
	it("is on a nullable array's own `items`, read with no anyOf step, in any DTO", async () => {
		const [[, create]] = (await documents()) as Array<[string, { properties: Record<string, Schema> }]> as [
			[string, { properties: Record<string, Schema> }],
		]
		expect(create.properties["nets"]?.items?.["x-comb-cidr"]).toBe(true)
		expect(create.properties["tags"]?.items?.["x-comb-text"]).toBe("no U+0000 or unpaired surrogate")
		const unstated: string[] = []
		for (const [name, { properties }] of await documents())
			for (const [key, schema] of Object.entries(properties)) {
				const array = schema.anyOf?.find(({ type }) => type === "array")
				if (array !== undefined) unstated.push(...unstatedItems(array.items, schema.items, `${name}.${key}.items`))
			}
		expect(unstated).toEqual([])
	})
})
