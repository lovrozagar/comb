/**
 * CS8, CS9 of r22b: a write rule zod holds in a refine is a rule the published document states, so
 * a client that validates from the spec sends nothing the server refuses. int64's range and real's
 * underflow are standard JSON Schema; a cidr's host bits and a multidimensional array's shape are
 * `x-comb-cidr` and `x-comb-rectangular` (meta-contract §2.1), which the contract reader applies.
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
	net: ["10.0.0.0/8", "10.0.0.1/8", "10.0.0.1", "192.168.1.0/24", "192.168.1.1/24", "::1", "fe80::/10", "fe80::1/10"],
	ratio: [0, 1.5, -1.5, 1e-50, -1e-50, 7.006492321624085e-46, 7.1e-46, -7.1e-46, 1e-45, 3.4028235e38, 3.5e38],
}

describe("the rules comb's refines hold, as the published document states them (CS8, AA3; siblings: int64, real, cidr, a rectangular array, nullable)", () => {
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

describe("a written plain JSON value (CS9)", () => {
	it("publishes its recursive definition once", async () => {
		const published = z.toJSONSchema(await create(), { io: "input" }) as Node
		expect(Object.keys((published["$defs"] ?? {}) as Node)).toHaveLength(1)
	})
})
