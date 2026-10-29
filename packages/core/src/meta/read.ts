/**
 * Reading comb's facts off a JSON Schema. Returns null, never throws: a refused or malformed
 * payload degrades to "no facts", never to a confident wrong answer. See docs/meta-contract.md §4.
 */
import {
	COMB_FILTER_GRAMMAR,
	COMB_META_KEY,
	COMB_META_VERSION,
	type CombEntityMeta,
	type CombFilterField,
	type CombMeta,
	type CombQueryMeta,
	type CombStatesMeta,
	type UniqueIndexMeta,
} from "./contract.ts"

type ReadOptions = {
	/**
	 * Highest contract version this reader understands. A payload newer than
	 * this is refused rather than partially read — see docs §4.2.
	 * Defaults to the version of the comb build doing the reading.
	 */
	maxVersion?: number
	/** Called instead of throwing when a payload is refused or malformed. */
	onDiagnostic?: (message: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string")
}

/**
 * Read comb's facts off the ROOT of a JSON Schema.
 *
 * Does not unwrap `items` for array schemas — the consumer that already
 * resolves which schema to read owns that step, so the two cannot disagree.
 *
 * Returns null, never throws: a refused or malformed payload must degrade to
 * "no facts" (which downstream handles as a visible coverage gap), not to a
 * confident wrong answer.
 */
function readCombMeta(jsonSchema: unknown, options: ReadOptions = {}): CombMeta | null {
	const { maxVersion = COMB_META_VERSION, onDiagnostic } = options

	if (!isRecord(jsonSchema)) return null
	const raw = jsonSchema[COMB_META_KEY]
	if (raw === undefined) return null

	const diagnose = (message: string): null => {
		onDiagnostic?.(`${COMB_META_KEY}: ${message}`)
		return null
	}

	if (!isRecord(raw)) return diagnose("payload is not an object")

	const v = raw["v"]
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
		return diagnose("payload has no valid integer `v`")
	}
	if (v > maxVersion) {
		return diagnose(`payload is v${v}, this reader understands up to v${maxVersion} — refusing to guess`)
	}

	const kind = raw["kind"]
	if (kind === "entity") return readEntity(raw, v, diagnose)
	if (kind === "query") return readQuery(raw, v, diagnose)
	return diagnose(`unknown kind ${JSON.stringify(kind)}`)
}

function readEntity(raw: Record<string, unknown>, v: number, diagnose: (m: string) => null): CombEntityMeta | null {
	const name = raw["name"]
	const identity = raw["identity"]
	if (typeof name !== "string" || typeof identity !== "string") {
		return diagnose("entity payload needs string `name` and `identity`")
	}

	const generated = raw["generated"]
	const immutable = raw["immutable"]
	if (!isStringArray(generated) || !isStringArray(immutable)) {
		return diagnose("entity payload needs string[] `generated` and `immutable`")
	}

	const softDelete = raw["softDelete"]
	const tenantColumn = raw["tenantColumn"]
	if (
		(softDelete !== null && typeof softDelete !== "string") ||
		(tenantColumn !== null && typeof tenantColumn !== "string")
	) {
		return diagnose("entity payload needs string-or-null `softDelete` and `tenantColumn`")
	}

	const states = readStates(raw["states"])
	if (states === "invalid") return diagnose("entity payload has a malformed `states`")

	const uniqueIndexes = readUniqueIndexes(raw["uniqueIndexes"])
	if (uniqueIndexes === "invalid") return diagnose("entity payload has a malformed `uniqueIndexes`")

	/* Unknown fields are dropped, not rejected — that is what makes additive
	   growth free for a producer newer than this reader. */
	return { generated, identity, immutable, kind: "entity", name, softDelete, states, tenantColumn, uniqueIndexes, v }
}

/**
 * `states` arrived in a later comb than the contract's v1, so a payload without
 * it is normal and reads as null — absence is not an error, only a malformed
 * value is.
 */
function readStates(raw: unknown): CombStatesMeta | null | "invalid" {
	if (raw === undefined || raw === null) return null
	if (!isRecord(raw)) return "invalid"

	const column = raw["column"]
	const values = raw["values"]
	const terminal = raw["terminal"]
	const initial = raw["initial"]

	if (typeof column !== "string" || !isStringArray(values) || !isStringArray(terminal)) return "invalid"
	if (initial !== null && initial !== undefined && typeof initial !== "string") return "invalid"
	/* a machine naming a state it does not declare is malformed, not partially trusted (docs §4.2) */
	if (typeof initial === "string" && !values.includes(initial)) return "invalid"
	if (!terminal.every((state) => values.includes(state))) return "invalid"

	return { column, initial: initial ?? null, terminal, values }
}

/**
 * `uniqueIndexes` arrived in a later comb than the contract's v1, so a payload
 * without it is normal and reads as [] — absence is not an error, only a
 * malformed value is.
 */
function readUniqueIndexes(raw: unknown): UniqueIndexMeta[] | "invalid" {
	if (raw === undefined) return []
	if (!Array.isArray(raw)) return "invalid"

	const indexes: UniqueIndexMeta[] = []
	for (const item of raw) {
		if (!isRecord(item)) return "invalid"
		const columns = item["columns"]
		const name = item["name"]
		if (!isStringArray(columns) || columns.length === 0 || typeof name !== "string") return "invalid"
		indexes.push({ columns, name })
	}
	return indexes
}

type Diagnose = (m: string) => null
type QueryRequired = Omit<
	CombQueryMeta,
	| "filterFields"
	| "kind"
	| "maxFilterConditions"
	| "maxFilterDepth"
	| "maxFilterValues"
	| "maxInValues"
	| "maxPatternBytes"
	| "maxPage"
	| "maxFilterBytes"
	| "maxQueryBytes"
	| "maxSearchBytes"
	| "maxSearchTerms"
	| "maxSortKeys"
	| "nulls"
	| "v"
>
type QueryOptional = Pick<
	CombQueryMeta,
	| "filterFields"
	| "maxFilterConditions"
	| "maxFilterDepth"
	| "maxFilterValues"
	| "maxInValues"
	| "maxPatternBytes"
	| "maxPage"
	| "maxFilterBytes"
	| "maxQueryBytes"
	| "maxSearchBytes"
	| "maxSearchTerms"
	| "maxSortKeys"
	| "nulls"
>

const isPositiveInt = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0

/* the fields every query payload carries */
function readQueryRequired(raw: Record<string, unknown>, diagnose: Diagnose): QueryRequired | null {
	const { defaultOrder, filterable, grammar, maxLimit, searchable, selectable, sortable, stableTiebreak } = raw
	if (!isStringArray(filterable) || !isStringArray(sortable) || !isStringArray(selectable)) {
		return diagnose("query payload needs string[] `filterable`, `sortable`, `selectable`")
	}
	if (searchable !== null && !isStringArray(searchable))
		return diagnose("query payload needs string[]-or-null `searchable`")
	if (!isPositiveInt(maxLimit)) return diagnose("query payload needs a positive integer `maxLimit`")
	if (typeof defaultOrder !== "string" || typeof stableTiebreak !== "string" || typeof grammar !== "string") {
		return diagnose("query payload needs string `defaultOrder`, `stableTiebreak`, `grammar`")
	}
	if (grammar !== COMB_FILTER_GRAMMAR) {
		return diagnose(
			`query payload \`grammar\` is ${JSON.stringify(grammar)}, this reader understands "${COMB_FILTER_GRAMMAR}"`,
		)
	}
	return { defaultOrder, filterable, grammar, maxLimit, searchable, selectable, sortable, stableTiebreak }
}

const isFilterField = (entry: unknown) =>
	isRecord(entry) &&
	typeof entry["field"] === "string" &&
	typeof entry["type"] === "string" &&
	isStringArray(entry["ops"])

/* fields added after v1: absent is normal, malformed is refused */
function readQueryOptional(raw: Record<string, unknown>, diagnose: Diagnose): QueryOptional | null {
	const optional: QueryOptional = {}
	const { filterFields, nulls } = raw
	if (filterFields !== undefined) {
		if (!Array.isArray(filterFields) || !filterFields.every(isFilterField)) {
			return diagnose("query payload `filterFields` needs {field, type, ops: string[]}[]")
		}
		optional.filterFields = filterFields as CombFilterField[]
	}
	if (nulls !== undefined) {
		if (!isStringArray(nulls) || !nulls.every((n) => n === "first" || n === "last")) {
			return diagnose('query payload `nulls` needs ("first" | "last")[]')
		}
		optional.nulls = nulls as Array<"first" | "last">
	}
	for (const key of [
		"maxFilterConditions",
		"maxFilterDepth",
		"maxFilterValues",
		"maxInValues",
		"maxPatternBytes",
		"maxFilterBytes",
		"maxQueryBytes",
		"maxSearchBytes",
		"maxSearchTerms",
		"maxSortKeys",
	] as const) {
		const value = raw[key]
		if (value === undefined) continue
		if (!isCount(value)) return diagnose(`query payload \`${key}\` needs a non-negative integer`)
		optional[key] = value
	}
	const { maxPage } = raw
	if (maxPage !== undefined) {
		if (!isPositiveInt(maxPage)) return diagnose("query payload `maxPage` needs a positive integer")
		optional.maxPage = maxPage
	}
	return optional
}

function readQuery(raw: Record<string, unknown>, v: number, diagnose: Diagnose): CombQueryMeta | null {
	const required = readQueryRequired(raw, diagnose)
	const optional = required === null ? null : readQueryOptional(raw, diagnose)
	return required === null || optional === null ? null : { ...required, kind: "query", v, ...optional }
}

/** Narrowing convenience — null when absent, refused, or the other kind. */
function readCombEntityMeta(jsonSchema: unknown, options?: ReadOptions): CombEntityMeta | null {
	const meta = readCombMeta(jsonSchema, options)
	return meta?.kind === "entity" ? meta : null
}

/** Narrowing convenience — null when absent, refused, or the other kind. */
function readCombQueryMeta(jsonSchema: unknown, options?: ReadOptions): CombQueryMeta | null {
	const meta = readCombMeta(jsonSchema, options)
	return meta?.kind === "query" ? meta : null
}

export { isRecord, type ReadOptions, readCombEntityMeta, readCombMeta, readCombQueryMeta }
