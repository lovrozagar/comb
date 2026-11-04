/**
 * CS8, CS9 of r22b: a write rule zod holds in a refine is a rule the published document states, so
 * a client that validates from the spec sends nothing the server refuses. int64's range and real's
 * underflow are standard JSON Schema; a cidr's host bits, a multidimensional array's shape and a
 * url's WHATWG parse are `x-comb-cidr`, `x-comb-rectangular` and `x-comb-url` (meta-contract §2.1),
 * which the contract reader applies.
 * And a written plain JSON value publishes its recursive definition once.
 */
import { Ajv2020 } from "ajv/dist/2020.js"
import { afterAll, describe, expect, it } from "vitest"
import * as z from "zod"
import { contractReader } from "../../src/__fixtures__/contract-reader.ts"
import { cleanGeneratedDtos, generatedDtos } from "../integration/support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const PG = `import { bigint, cidr, integer, jsonb, real } from "drizzle-orm/pg-core"
export const row = pgTable("row", {
	id: c.id("row"),
	big: bigint("big", { mode: "string" }).notNull(),
	ratio: real("ratio").notNull(),
	net: cidr("net").notNull(),
	grid: integer("grid").array("[][]").notNull(),
	netn: cidr("netn"),
	nets: cidr("nets").array(),
	gridn: integer("gridn").array("[][]"),
	raw: jsonb("raw"),
	site: c.text("site", { url: true }).notNull(),
	siten: c.text("siten", { url: true }),
})`

const create = async (): Promise<z.ZodObject> =>
	(await generatedDtos("published-refines", PG, { dialect: "postgres" }))["row"]?.["rowDtoCreateSchema"] as z.ZodObject

type Node = Record<string, unknown>

/**
 * What a reader of the published field takes: the standard schema, then the `x-comb-*` keys where
 * §2.1 puts them, on the property's own schema and an element's on the array's `items`, with no `anyOf` walk for a key
 * (AA3 of area A's review: a nullable field's keys sat in its member alone)
 */
function readerOf(field: Node): (value: unknown) => boolean {
	const validate = new Ajv2020({ logger: false, strict: false, validateFormats: true, formats: FORMATS }).compile(field)
	/* a nullable array's items is its array member's, as JSON Schema writes one */
	const array = [field, ...((field["anyOf"] ?? []) as Node[])].find((each) => each["type"] === "array")
	const items = array?.["items"] as Node | undefined
	return (value) =>
		validate(value) &&
		contractReader(field, value) &&
		(items === undefined || !Array.isArray(value) || value.every((element) => contractReader(items, element)))
}

/* the formats a cidr's branches publish, as a reader's format library checks them */
const FORMATS = {
	cidrv4: /^(?:\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
	cidrv6: /^[\da-f:]+\/\d{1,3}$/i,
	ipv4: /^(?:\d{1,3}\.){3}\d{1,3}$/,
	ipv6: /^[\da-f:]+$/i,
}

/* values at each rule's edges, by field */
const EDGES: Record<string, unknown[]> = {
	big: [
		"9223372036854775807",
		"9223372036854775808",
		"-9223372036854775808",
		"-9223372036854775809",
		"12345678901234567890",
		"9".repeat(19),
		"1".padEnd(19, "0"),
		"9223372036854775799",
		"9223372036854775710",
		"0009223372036854775807",
		"007",
		"-0",
		"1".repeat(18),
		"+1",
		"1e3",
		"",
	],
	grid: [
		[],
		[[]],
		[
			[1, 2],
			[3, 4],
		],
		[[1, 2], [3]],
		[[1], [2], [3]],
		[[1], []],
	],
	gridn: [null, [[1, 2], [3]], [[1], [2]]],
	netn: [null, "10.0.0.0/8", "10.0.0.1/8", "fe80::1/10"],
	nets: [null, ["10.0.0.0/8"], ["10.0.0.1/8"], ["10.0.0.0/8", "192.168.1.1/24"]],
	/* A3-3 of r23: a written url's WHATWG parse, as x-comb-url states it; https:a.co parses, and the pattern refuses it */
	site: [
		"https://ex.co/a",
		"https://ex.co:99999",
		"https://ex.co:65536",
		"https://[::1",
		"https://a b",
		"https://%zz",
		"https://ex.co:abc",
		"https://:80",
		"https://a@",
		"https://1.2.3.4.5",
		"https://999.1.1.1",
		"https://a\tb.co/x",
		"https:a.co",
	],
	siten: [null, "https://ex.co/a", "https://a b", "https://:80"],
	net: ["10.0.0.0/8", "10.0.0.1/8", "10.0.0.1", "192.168.1.0/24", "192.168.1.1/24", "::1", "fe80::/10", "fe80::1/10"],
	ratio: [0, 1.5, -1.5, 1e-50, -1e-50, 7.006492321624085e-46, 7.1e-46, -7.1e-46, 1e-45, 3.4028235e38, 3.5e38],
}

describe("the rules comb's refines hold, as the published document states them (CS8, AA3; siblings: int64, real, cidr, a rectangular array, url, nullable)", () => {
	it.each(Object.keys(EDGES))(
		"%s: a reader of the published field reaches zod's verdict on every edge",
		async (key) => {
			const schema = await create()
			const field = (z.toJSONSchema(schema, { io: "input" }).properties as Record<string, Node>)[key] as Node
			const reader = readerOf(field)
			const parse = schema.shape[key] as z.ZodType
			const disagree = (EDGES[key] as unknown[]).filter((value) => parse.safeParse(value).success !== reader(value))
			expect(disagree).toEqual([])
		},
	)
})

/* A3-3 of r23: the WHATWG parser's own rewrite is a transform the url publishes, which a reader applies before x-comb-url */
describe("a written url's published rewrites", () => {
	it.each(["site", "siten"])("%s publishes trim, then strip-tab-newline", async (key) => {
		const field = (z.toJSONSchema(await create(), { io: "input" }).properties as Record<string, Node>)[key] as Node
		expect(field["x-comb-transform"]).toEqual(["trim", "strip-tab-newline"])
	})
})

describe("a written plain JSON value (CS9)", () => {
	it("publishes its recursive definition once", async () => {
		const published = z.toJSONSchema(await create(), { io: "input" }) as Node
		expect(Object.keys((published["$defs"] ?? {}) as Node)).toHaveLength(1)
	})

	/* AA9 of r22: under its own id, so a recursive c.json beside it does not renumber the definition a
	   client names; the read DTO's too, the response type a client generates (A2-4 of r22) */
	const TREE = '\n\ttree: c.json("tree", treeSchema),'
	const WRITE = { dto: "rowDtoCreateSchema", io: "input" } as const
	const READ = { dto: "rowDtoReadSchema", io: "output" } as const
	it.each([
		{ label: "alone", tree: "", ...WRITE },
		{ label: "beside a recursive c.json before it", tree: TREE, ...WRITE },
		{ label: "alone, on a read", tree: "", ...READ },
		{ label: "on a read, beside a recursive c.json before it", tree: TREE, ...READ },
	])("names it CombJsonValue $label", async ({ dto, io, label, tree }) => {
		const tables = `import { jsonb } from "drizzle-orm/pg-core"
import * as z from "zod"
export const treeSchema = z.object({ name: z.string(), get kids() { return z.array(treeSchema) } })
export const row = pgTable("row", {
	id: c.id("row"),${tree}
	raw: jsonb("raw"),
})`
		const dtos = await generatedDtos(`published-json-${label.length}`, tables, { dialect: "postgres" })
		const published = z.toJSONSchema(dtos["row"]?.[dto] as z.ZodObject, { io }) as Node
		const raw = JSON.stringify((published["properties"] as Node)["raw"])
		expect(raw.match(/#\/\$defs\/([^"]+)/)?.[1]).toBe("CombJsonValue")
		expect(Object.keys(published["$defs"] as Node)).toContain("CombJsonValue")
	})
})

/* A3-4 of r23: an app's recursive schema under its own id, in a written c.json, publishes one document
   per DTO, whatever the process converted before it: comb's refine sits outside the lazy */
describe("a written c.json of a getter-recursive schema under its own id", () => {
	const TABLES = `import * as z from "zod"
export type Tree = { name: string; kids: Tree[] }
export const Tree: z.ZodType<Tree> = z.object({ name: z.string(), get kids() { return z.array(Tree) } }).meta({ id: "AppTree" })
export const row = pgTable("row", { id: c.id("row"), tree: c.json("tree", Tree).notNull() })`

	/** The update DTO's $defs, its entity's create DTO converted first or not, in modules of their own */
	async function updateDefs(createFirst: boolean): Promise<string[]> {
		const dtos = await generatedDtos(`published-tree-${createFirst}`, TABLES, { dialect: "postgres" })
		const entity = dtos["row"] as Record<string, z.ZodObject>
		if (createFirst) z.toJSONSchema(entity["rowDtoCreateSchema"] as z.ZodObject, { io: "input" })
		const published = z.toJSONSchema(entity["rowDtoUpdateSchema"] as z.ZodObject, { io: "input" }) as Node
		return Object.keys((published["$defs"] ?? {}) as Node)
	}

	it("publishes the update DTO's definitions alike, alone or after the create DTO", async () => {
		const alone = await updateDefs(false)
		expect(alone).toEqual(["AppTree"])
		expect(await updateDefs(true)).toEqual(alone)
	})
})
