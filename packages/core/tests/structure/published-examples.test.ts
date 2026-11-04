/**
 * CS7 of r22b, QL8 of r22b: an example is a value the schema tells a client to send, so every
 * example a list or retrieve query schema publishes parses through that schema: a contract tester
 * or a docs page that sends one gets no 400 from a correct server. The examples come from the
 * endpoint's config, as `filter`'s do; a cursor, sealed under the app's secret and scope, has no
 * example that any endpoint opens, so it publishes none.
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createListQuerySchema, createRetrieveQuerySchema } from "../../src/query/index.ts"

type Config = Parameters<typeof createListQuerySchema>[0]

/* README's endpoint, one with a relation and tight limits, and one with no relation */
const CONFIGS: Array<[name: string, config: Config]> = [
	[
		"README's",
		{
			fields: { scalars: ["id", "title", "created_at"] },
			filter: { created_at: "date", minute_read: "number", status: "enum", title: "string" },
			lang: true,
			limits: { maxConditions: 20, maxDepth: 3, maxInValues: 50, maxSearchTerms: 8, maxSortKeys: 3, maxValues: 60 },
			pagination: { defaultLimit: 20, maxLimit: 100, maxPage: 10_000 },
			search: ["title"],
			sort: ["created_at", "title"],
		},
	],
	[
		"a relation's, at tight limits",
		{
			fields: { relationFields: { author: ["name", "email"] }, relations: ["author"], scalars: ["id", "body"] },
			limits: { maxSortKeys: 1 },
			pagination: { defaultLimit: 5, maxLimit: 10 },
			sort: ["created_at", "title"],
		},
	],
	["one with no relation", { fields: { scalars: ["id"] }, sort: ["id"] }],
]

type Node = Record<string, unknown>

/** Every example a published param states, wherever its schema nests them */
function examplesOf(node: unknown, found: unknown[] = []): unknown[] {
	if (Array.isArray(node)) for (const child of node) examplesOf(child, found)
	else if (node !== null && typeof node === "object")
		for (const [key, child] of Object.entries(node)) {
			if (key === "examples" && Array.isArray(child)) found.push(...child)
			else examplesOf(child, found)
		}
	return found
}

/** Each param's examples that its own schema refuses, as `param=example: issues` */
function refusedExamples(schema: z.ZodType): string[] {
	const params = (z.toJSONSchema(schema, { io: "input" }) as Node)["properties"] as Record<string, Node>
	return Object.entries(params).flatMap(([param, published]) =>
		examplesOf(published).flatMap((example) => {
			const result = schema.safeParse({ [param]: example })
			return result.success ? [] : [`${param}=${JSON.stringify(example)}: ${result.error.issues[0]?.message}`]
		}),
	)
}

describe("every example a query schema publishes parses through it (CS7, QL8; siblings: limit, select, order, cursor)", () => {
	it.each(CONFIGS)("on %s list endpoint", (_, config) => {
		expect(refusedExamples(createListQuerySchema(config))).toEqual([])
	})

	it.each(CONFIGS)("on %s retrieve endpoint", (_, config) => {
		const { fields = { scalars: [] }, lang } = config
		expect(refusedExamples(createRetrieveQuerySchema({ fields, ...(lang ? { lang } : {}) }))).toEqual([])
	})

	it.each(CONFIGS)(
		"on %s list endpoint, the cursor states no example, and limit, select and order state some",
		(_, config) => {
			const params = (z.toJSONSchema(createListQuerySchema(config), { io: "input" }) as Node)["properties"] as Record<
				string,
				Node
			>
			expect(examplesOf(params["cursor"])).toEqual([])
			for (const param of ["limit", "order", "select"])
				expect(examplesOf(params[param]).length, param).toBeGreaterThan(0)
		},
	)
})
