/**
 * The comb meta contract — facts about tables and queries, stamped onto Zod
 * schemas so they survive the trip to JSON Schema and into an OpenAPI document.
 *
 * comb publishes facts in comb's vocabulary. Mapping them to a consumer's tag
 * names is the consumer's job. See docs/meta-contract.md.
 */

/** Reserved key. One collision surface, one version field. */
const COMB_META_KEY = "x-comb"

/**
 * Contract version. Bumped ONLY on a breaking change — a field removed, or a
 * field whose meaning changed. Adding a field never bumps it, which is what
 * lets comb and its consumers ship independently.
 */
const COMB_META_VERSION = 1

type CombMetaKind = "entity" | "query"

/** Filter grammar comb's parser implements — `field.op.value`. */
const COMB_FILTER_GRAMMAR = "postgrest"

type CombFilterGrammar = typeof COMB_FILTER_GRAMMAR

/** Facts about an entity, derived from its table definition. */
type CombEntityMeta = {
	v: number
	kind: "entity"
	/** Entity name — the SQL table name */
	name: string
	/** Primary key / stable identifier column */
	identity: string
	/** Server-assigned: omitted from create bodies, expected in responses */
	generated: string[]
	/** Must reject or ignore a mutation */
	immutable: string[]
	/** Tombstone column, or null when the entity is hard-deleted */
	softDelete: string | null
	/** Column scoping rows to a tenant, or null when comb cannot know (see docs §6.2) */
	tenantColumn: string | null
}

/** Facts about a list query, derived from the config that parses the request. */
type CombQueryMeta = {
	v: number
	kind: "query"
	filterable: string[]
	sortable: string[]
	/** null = not knowable at this layer, which is not the same as "none" (docs §6.1) */
	searchable: string[] | null
	selectable: string[]
	maxLimit: number
	/** e.g. "created_at.desc" — the order applied when the request names none */
	defaultOrder: string
	/** Tiebreak column for keyset pagination */
	stableTiebreak: string
	grammar: CombFilterGrammar
}

type CombMeta = CombEntityMeta | CombQueryMeta

/** Payload accepted by combMeta() — the version is stamped for you. */
type CombEntityMetaInput = Omit<CombEntityMeta, "v">
type CombQueryMetaInput = Omit<CombQueryMeta, "v">
type CombMetaInput = CombEntityMetaInput | CombQueryMetaInput

/** The object combMeta() produces, ready for `.meta()`. */
type CombMetaStamp<T extends CombMeta = CombMeta> = { [COMB_META_KEY]: T }

/**
 * Build the stamp for a Zod `.meta()` call.
 *
 * Stamp the schema you RETURN, not the one you build from — a transform/pipe
 * does not forward the base's metadata to the output view. See docs §3.1.
 */
function combMeta(meta: CombEntityMetaInput): CombMetaStamp<CombEntityMeta>
function combMeta(meta: CombQueryMetaInput): CombMetaStamp<CombQueryMeta>
function combMeta(meta: CombMetaInput): CombMetaStamp {
	return { [COMB_META_KEY]: { ...meta, v: COMB_META_VERSION } as CombMeta }
}

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

	/* Unknown fields are dropped, not rejected — that is what makes additive
	   growth free for a producer newer than this reader. */
	return { generated, identity, immutable, kind: "entity", name, softDelete, tenantColumn, v }
}

function readQuery(raw: Record<string, unknown>, v: number, diagnose: (m: string) => null): CombQueryMeta | null {
	const filterable = raw["filterable"]
	const sortable = raw["sortable"]
	const selectable = raw["selectable"]
	if (!isStringArray(filterable) || !isStringArray(sortable) || !isStringArray(selectable)) {
		return diagnose("query payload needs string[] `filterable`, `sortable`, `selectable`")
	}

	const searchable = raw["searchable"]
	if (searchable !== null && !isStringArray(searchable)) {
		return diagnose("query payload needs string[]-or-null `searchable`")
	}

	const maxLimit = raw["maxLimit"]
	if (typeof maxLimit !== "number" || !Number.isInteger(maxLimit) || maxLimit < 1) {
		return diagnose("query payload needs a positive integer `maxLimit`")
	}

	const defaultOrder = raw["defaultOrder"]
	const stableTiebreak = raw["stableTiebreak"]
	const grammar = raw["grammar"]
	if (typeof defaultOrder !== "string" || typeof stableTiebreak !== "string" || typeof grammar !== "string") {
		return diagnose("query payload needs string `defaultOrder`, `stableTiebreak`, `grammar`")
	}

	return {
		defaultOrder,
		filterable,
		grammar: grammar as CombFilterGrammar,
		kind: "query",
		maxLimit,
		searchable,
		selectable,
		sortable,
		stableTiebreak,
		v,
	}
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

/** Minimal shape of a Zod schema, so this module needs no zod import. */
type MetaCarrier<T> = { meta: (m: Record<string, unknown>) => T }

/**
 * Re-stamp `to` with the facts `from` carries.
 *
 * `.extend()` drops registry metadata silently (docs §5), so a consumer who
 * extends a generated read schema loses the entity facts with no diagnostic.
 * This is the recovery path.
 */
function carryCombMeta<T>(from: unknown, to: MetaCarrier<T>): T | null {
	const meta = readCombMeta(toJsonSchemaLike(from))
	if (!meta) return null
	return to.meta({ [COMB_META_KEY]: meta })
}

/** Accept either a JSON Schema object or something already holding the key. */
function toJsonSchemaLike(value: unknown): unknown {
	if (isRecord(value) && COMB_META_KEY in value) return value
	return value
}

export {
	carryCombMeta,
	COMB_FILTER_GRAMMAR,
	COMB_META_KEY,
	COMB_META_VERSION,
	combMeta,
	type CombEntityMeta,
	type CombEntityMetaInput,
	type CombFilterGrammar,
	type CombMeta,
	type CombMetaInput,
	type CombMetaKind,
	type CombMetaStamp,
	type CombQueryMeta,
	type CombQueryMetaInput,
	readCombEntityMeta,
	readCombMeta,
	readCombQueryMeta,
}
