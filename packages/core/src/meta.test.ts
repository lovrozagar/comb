import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
	COMB_FILTER_GRAMMAR,
	COMB_META_KEY,
	COMB_META_VERSION,
	carryCombMeta,
	type CombEntityMetaInput,
	type CombQueryMetaInput,
	combMeta,
	readCombEntityMeta,
	readCombMeta,
	readCombQueryMeta,
} from "./meta.ts"

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

describe("combMeta and the readers", () => {
	it("stamps the current version and reads both kinds back", () => {
		const stamp = combMeta(ENTITY)
		expect(stamp[COMB_META_KEY].v).toBe(COMB_META_VERSION)
		expect(readCombEntityMeta(stamp)).toEqual({ ...ENTITY, v: COMB_META_VERSION })
		expect(readCombQueryMeta(combMeta(QUERY))).toMatchObject({ grammar: "postgrest", kind: "query" })
		expect(readCombEntityMeta(combMeta(QUERY))).toBeNull()
		expect(readCombQueryMeta(combMeta(ENTITY))).toBeNull()
	})

	it("reads nothing from what carries no payload", () => {
		expect(readCombMeta(null)).toBeNull()
		expect(readCombMeta([])).toBeNull()
		expect(readCombMeta({ type: "object" })).toBeNull()
	})

	it.each([
		["not an object", "x", "payload is not an object"],
		["no version", { kind: "entity" }, "payload has no valid integer `v`"],
		["a fractional version", { kind: "entity", v: 1.5 }, "payload has no valid integer `v`"],
		["an unknown kind", { kind: "view", v: 1 }, 'unknown kind "view"'],
	])("refuses a payload with %s", (_name, payload, message) => {
		expect(read(payload)).toEqual({ meta: null, said: [`${COMB_META_KEY}: ${message}`] })
	})

	it("refuses a payload newer than the reader instead of guessing", () => {
		expect(read({ ...ENTITY, v: 3 }, 2).said).toEqual([
			`${COMB_META_KEY}: payload is v3, this reader understands up to v2 — refusing to guess`,
		])
	})
})

describe("carryCombMeta", () => {
	it("re-stamps an extended Zod schema with the facts the original carries (M-M10)", () => {
		const base = z.object({ id: z.string() }).meta(combMeta(ENTITY))
		const extended = carryCombMeta(base, base.extend({ extra: z.string() }))
		expect(extended).not.toBeNull()
		expect(readCombEntityMeta(z.toJSONSchema(extended as z.ZodObject))).toMatchObject({ name: "post" })
	})

	it("re-stamps from a JSON Schema, and gives null when the source carries nothing", () => {
		const base = z.object({ id: z.string() }).meta(combMeta(ENTITY))
		expect(carryCombMeta(z.toJSONSchema(base), z.object({}))).not.toBeNull()
		expect(carryCombMeta(z.object({}), z.object({}))).toBeNull()
		expect(carryCombMeta({ meta: () => undefined }, z.object({}))).toBeNull()
		expect(carryCombMeta("x", z.object({}))).toBeNull()
	})
})
