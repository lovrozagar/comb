import { describe, expect, it } from "vitest"
import { COMB_FILTER_GRAMMAR, COMB_META_KEY, type CombEntityMetaInput, type CombQueryMetaInput } from "./contract.ts"
import { readCombMeta } from "./read.ts"

const ENTITY: CombEntityMetaInput = {
	generated: ["id"],
	identity: "id",
	immutable: ["id"],
	kind: "entity",
	name: "post",
	softDelete: null,
	states: { column: "status", initial: "draft", terminal: ["live"], values: ["draft", "live"] },
	tenantColumn: null,
	uniqueIndexes: [{ columns: ["slug"], name: "post_slug" }],
}

const QUERY: CombQueryMetaInput = {
	defaultOrder: "id.asc",
	filterable: ["status"],
	grammar: COMB_FILTER_GRAMMAR,
	kind: "query",
	maxLimit: 100,
	searchable: null,
	selectable: ["id"],
	sortable: ["id"],
	stableTiebreak: "id",
}

function read(payload: unknown, maxVersion?: number) {
	const said: string[] = []
	const options = { onDiagnostic: (m: string) => said.push(m), ...(maxVersion === undefined ? {} : { maxVersion }) }
	return { meta: readCombMeta({ [COMB_META_KEY]: payload }, options), said }
}

const ENTITY_REFUSALS: Array<[string, unknown, string]> = [
	["a missing name", { ...ENTITY, name: 1 }, "entity payload needs string `name` and `identity`"],
	["a non-list generated", { ...ENTITY, generated: "id" }, "entity payload needs string[] `generated` and `immutable`"],
	[
		"a numeric softDelete",
		{ ...ENTITY, softDelete: 1 },
		"entity payload needs string-or-null `softDelete` and `tenantColumn`",
	],
	[
		"a numeric tenantColumn",
		{ ...ENTITY, tenantColumn: 1 },
		"entity payload needs string-or-null `softDelete` and `tenantColumn`",
	],
	["states that are no object", { ...ENTITY, states: [] }, "entity payload has a malformed `states`"],
	[
		"states without values",
		{ ...ENTITY, states: { column: "s", terminal: [] } },
		"entity payload has a malformed `states`",
	],
	[
		"a numeric initial",
		{ ...ENTITY, states: { ...ENTITY.states, initial: 1 } },
		"entity payload has a malformed `states`",
	],
	[
		"an initial that is no value (L3)",
		{ ...ENTITY, states: { ...ENTITY.states, initial: "gone" } },
		"entity payload has a malformed `states`",
	],
	[
		"a terminal that is no value (L3)",
		{ ...ENTITY, states: { ...ENTITY.states, terminal: ["gone"] } },
		"entity payload has a malformed `states`",
	],
	["indexes that are no list", { ...ENTITY, uniqueIndexes: {} }, "entity payload has a malformed `uniqueIndexes`"],
	["an index that is no object", { ...ENTITY, uniqueIndexes: ["x"] }, "entity payload has a malformed `uniqueIndexes`"],
	[
		"an index without columns",
		{ ...ENTITY, uniqueIndexes: [{ columns: [], name: "x" }] },
		"entity payload has a malformed `uniqueIndexes`",
	],
]

describe("readCombMeta: entity payloads", () => {
	it.each(ENTITY_REFUSALS)("refuses %s", (_name, payload, message) => {
		expect(read({ ...(payload as object), v: 1 })).toEqual({ meta: null, said: [`${COMB_META_KEY}: ${message}`] })
	})

	it("reads absent states and indexes as none, and a missing initial as null", () => {
		const { states: _s, uniqueIndexes: _u, ...bare } = ENTITY
		expect(read({ ...bare, v: 1 }).meta).toMatchObject({ states: null, uniqueIndexes: [] })
		const noInitial = { column: "status", terminal: ["live"], values: ["draft", "live"] }
		expect(read({ ...ENTITY, states: noInitial, v: 1 }).meta).toMatchObject({ states: { initial: null } })
		expect(read({ ...ENTITY, extra: true, v: 1 }).meta).not.toHaveProperty("extra")
	})
})

describe("readCombMeta: query payloads", () => {
	it.each([
		[
			"a non-list filterable",
			{ ...QUERY, filterable: "x" },
			"query payload needs string[] `filterable`, `sortable`, `selectable`",
		],
		["a numeric searchable", { ...QUERY, searchable: 1 }, "query payload needs string[]-or-null `searchable`"],
		["a zero maxLimit", { ...QUERY, maxLimit: 0 }, "query payload needs a positive integer `maxLimit`"],
		[
			"a numeric defaultOrder",
			{ ...QUERY, defaultOrder: 1 },
			"query payload needs string `defaultOrder`, `stableTiebreak`, `grammar`",
		],
		[
			"an unknown grammar (L3)",
			{ ...QUERY, grammar: "sql" },
			'query payload `grammar` is "sql", this reader understands "postgrest"',
		],
		[
			"malformed filterFields",
			{ ...QUERY, filterFields: [{ field: "a" }] },
			"query payload `filterFields` needs {field, type, ops: string[]}[]",
		],
		["unknown null placements", { ...QUERY, nulls: ["middle"] }, 'query payload `nulls` needs ("first" | "last")[]'],
		[
			"a negative limit field",
			{ ...QUERY, maxInValues: -1 },
			"query payload `maxInValues` needs a non-negative integer",
		],
	])("refuses %s", (_name, payload, message) => {
		expect(read({ ...payload, v: 1 })).toEqual({ meta: null, said: [`${COMB_META_KEY}: ${message}`] })
	})

	it("reads the optional fields it knows", () => {
		const payload = {
			...QUERY,
			filterFields: [{ field: "status", ops: ["eq"], type: "string" }],
			maxSortKeys: 3,
			nulls: ["last"],
			v: 1,
		}
		expect(read(payload).meta).toMatchObject({ filterFields: payload.filterFields, maxSortKeys: 3, nulls: ["last"] })
	})
})
