/**
 * C1, C2 of r22: every `x-comb-*` key and every `x-comb-transform` value comb publishes is one
 * meta-contract §2.1 defines, so a reader built from the contract knows each one, and a root
 * export's published schema, read as §2.1 defines its keys, takes what its parse takes. The walk
 * covers each DTO codegen writes for a table of every kind that publishes a key, on both dialects,
 * and each root export that builds a schema.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as z from "zod"
import * as root from "../../src/index.ts"
import { CONTRACT_KEYS, CONTRACT_TRANSFORMS, contractReader } from "../../src/__fixtures__/contract-reader.ts"
import { cleanGeneratedDtos, generatedDtos } from "../integration/support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const CONTRACT = readFileSync(join(import.meta.dirname, "../../docs/meta-contract.md"), "utf8")
const FIELD_KEYS = CONTRACT.slice(CONTRACT.indexOf("### 2.1 Field keys"), CONTRACT.indexOf("## 3. Producer API"))

/** The keys §2.1 defines: the backticked names that head each of its top-level bullets, before the colon */
function definedKeys(): string[] {
	const bullets = FIELD_KEYS.split(/\n(?=- )/).filter((bullet) => bullet.startsWith("- `x-comb-"))
	return bullets.flatMap((bullet) => {
		const head = bullet.slice(0, bullet.search(/`:/) + 1)
		return [...head.matchAll(/`(x-comb-[A-Za-z0-9]+)`/g)].map(([, key]) => key as string)
	})
}

/** The transforms §2.1 defines, one sub-bullet each */
const definedTransforms = (): string[] =>
	[...FIELD_KEYS.matchAll(/^ {2}- `"(\w+)"`:/gm)].map(([, name]) => name as string)

type Found = { keys: Set<string>; transforms: Set<string> }

/** Each `x-comb-*` key anywhere in `node`, and each transform an `x-comb-transform` lists */
function collect(node: unknown, found: Found): Found {
	if (Array.isArray(node)) for (const child of node) collect(child, found)
	else if (node !== null && typeof node === "object")
		for (const [key, child] of Object.entries(node)) {
			if (key.startsWith("x-comb-")) found.keys.add(key)
			if (key === "x-comb-transform") for (const name of child as string[]) found.transforms.add(name)
			collect(child, found)
		}
	return found
}

const PG = `import { cidr, inet, integer, interval, json, jsonb, macaddr, numeric, text, time, varchar } from "drizzle-orm/pg-core"
import * as z from "zod"
export const Doc = z.object({ a: z.string() })
export const Reg = z.object({ b: z.string() }).meta({ id: "XcombKeysReg" })
export const row = pgTable("row", {
	id: c.id("row"),
	title: c.text("title", { max: 50, min: 2, trim: true }),
	upper: c.text("upper", { uppercase: true }),
	lower: c.text("lower", { lowercase: true, max: 20 }),
	mail: c.text("mail", { email: true, max: 90 }),
	site: c.text("site", { url: true }),
	image: c.text("image", { imageUri: true }),
	label: c.text("label", { name: true }),
	secret: c.text("secret", { password: true }),
	ratio: c.real("ratio", { max: 1, min: 0 }),
	count: c.integer("count", { max: 9, min: 1 }),
	at: c.timestamp("at", { max: 4102444800000, min: 0 }),
	doc: c.json("doc", Doc, { maxBytes: 64 }),
	docs: c.json("docs", Doc).array(),
	reg: c.json("reg", Reg),
	raw: jsonb("raw"),
	plain: json("plain"),
	tags: text("tags").array(),
	grid: integer("grid").array("[][]"),
	short: c.text("short", { max: 5 }).array(),
	nums: c.integer("nums", { max: 9, min: 1 }).array(),
	name: varchar("name", { length: 12 }),
	money: numeric("money", { precision: 5, scale: 2 }),
	ip: inet("ip"),
	net: cidr("net"),
	mac: macaddr("mac"),
	span: interval("span"),
	clock: time("clock"),
})`

const SQLITE = `import { integer, real, text } from "drizzle-orm/sqlite-core"
import * as z from "zod"
export const Doc = z.object({ a: z.string() })
export const row = sqliteTable("row", {
	id: c.id("row"),
	title: c.text("title", { max: 50, min: 2, trim: true }),
	mail: c.text("mail", { email: true }),
	upper: c.text("upper", { uppercase: true }),
	ratio: c.real("ratio", { max: 1, min: 0 }),
	count: c.integer("count", { max: 9, min: 1 }),
	doc: c.json("doc", Doc, { maxBytes: 64 }),
	raw: text("raw", { mode: "json" }),
	plain: text("plain", { length: 10 }),
	n: integer("n"),
	r: real("r"),
})`

/** The JSON Schema of every DTO codegen writes for the fixture tables, on both dialects */
async function codegenDocuments(): Promise<unknown[]> {
	const documents: unknown[] = []
	for (const [dialect, tables] of [
		["postgres", PG],
		["sqlite", SQLITE],
	] as const) {
		const dtos = await generatedDtos(`xcomb-keys-${dialect}`, tables, { dialect })
		for (const schema of Object.values(dtos["row"] as Record<string, unknown>))
			if (schema instanceof z.ZodType)
				for (const io of ["input", "output"] as const)
					documents.push(z.toJSONSchema(schema, { io, unrepresentable: "any" }))
	}
	return documents
}

/**
 * Each schema a root export builds, by the call that builds it: every exported function called with
 * no arguments that gives a zod schema, and the option a factory's keys depend on
 */
function rootSchemas(): Array<[string, z.ZodType]> {
	const built: Array<[string, z.ZodType]> = []
	for (const [name, value] of Object.entries(root)) {
		if (typeof value !== "function") continue
		let schema: unknown
		try {
			schema = (value as () => unknown)()
		} catch {
			continue
		}
		if (schema instanceof z.ZodType) built.push([`${name}()`, schema])
	}
	built.push(
		['passwordText({ hash: "bcrypt" })', root.passwordText({ hash: "bcrypt" })],
		["passwordText.typed()", root.passwordText.typed()],
		['passwordText.typed({ hash: "bcrypt" })', root.passwordText.typed({ hash: "bcrypt" })],
	)
	return built
}

const published = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>

/* values at the edges a published key binds: bcrypt's bytes as ASCII, a quote JSON escapes, NFD text */
const PROBES = [
	"x".repeat(14),
	"x".repeat(15),
	"x".repeat(71),
	"x".repeat(72),
	"x".repeat(73),
	`"${"x".repeat(70)}"`,
	"e\u0301".repeat(8),
	"e\u0301".repeat(36),
	"e\u0301".repeat(128),
	`${"x".repeat(15)}\u0000`,
]

describe("the x-comb keys comb publishes (C1, C2; siblings: codegen's transforms and a read's stated bounds)", () => {
	it("are each one meta-contract §2.1 defines, and the contract reader knows exactly those", async () => {
		const found: Found = { keys: new Set(), transforms: new Set() }
		for (const document of await codegenDocuments()) collect(document, found)
		for (const [, schema] of rootSchemas()) collect(published(schema), found)
		const keys = definedKeys()
		expect([...found.keys].filter((key) => !keys.includes(key))).toEqual([])
		expect([...found.transforms].filter((name) => !definedTransforms().includes(name))).toEqual([])
		expect(keys.toSorted()).toEqual([...CONTRACT_KEYS].toSorted())
		expect(definedTransforms().toSorted()).toEqual(Object.keys(CONTRACT_TRANSFORMS).toSorted())
	})

	it("finds the root exports that build a schema, passwordText and storableText among them", () => {
		const names = rootSchemas().map(([name]) => name)
		expect(names).toEqual(expect.arrayContaining(["passwordText()", "storableText()"]))
	})

	it("read as §2.1 defines them, take on a root export's schema what its parse takes", () => {
		for (const [name, schema] of rootSchemas()) {
			const keys = published(schema)
			for (const value of PROBES)
				expect(contractReader(keys, value), `${name} on ${JSON.stringify(value)}`).toBe(schema.safeParse(value).success)
		}
	})
})
