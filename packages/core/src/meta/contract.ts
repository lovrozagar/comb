/**
 * The comb meta contract — facts about tables and queries, stamped onto Zod
 * schemas so they survive the trip to JSON Schema and into an OpenAPI document.
 *
 * comb publishes facts in comb's vocabulary. Mapping them to a consumer's tag
 * names is the consumer's job. See docs/meta-contract.md.
 */
import type { UniqueIndexMeta } from "../codegen/analyzer-types.ts"

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
	/** Column scoping rows to a tenant, or null when comb cannot know (see docs §6.3) */
	tenantColumn: string | null
	/**
	 * Lifecycle of the entity's state column, or null when none is declared.
	 *
	 * `transitions` is deliberately absent: it is a write-side rule, and
	 * publishing the graph would invite a consumer to drive state by walking it.
	 * See docs/state-machines.md §5.
	 */
	states: CombStatesMeta | null
	/**
	 * Unique indexes declared with `uniqueIndex()`, in the order the analyzer
	 * extracted them. Empty when none. Never inferred from PKs or column names.
	 */
	uniqueIndexes: UniqueIndexMeta[]
}

/** The published subset of a column state machine — describes a lifecycle, not how to drive it. */
type CombStatesMeta = {
	column: string
	values: string[]
	initial: string | null
	terminal: string[]
}

/** One filterable field with the operators its type accepts. */
type CombFilterField = {
	field: string
	type: string
	ops: string[]
}

/**
 * Facts about a list query, derived from the config that parses the request.
 * Fields marked optional were added after v1 shipped; a v1 reader built before
 * them ignores them, which is why adding them did not bump `v`.
 */
type CombQueryMeta = {
	v: number
	kind: "query"
	filterable: string[]
	/** `filterable` with types and operators */
	filterFields?: CombFilterField[]
	sortable: string[]
	/** Null placements every sortable field accepts */
	nulls?: Array<"first" | "last">
	maxFilterConditions?: number
	maxFilterDepth?: number
	/** Values one filter binds in all, every in/nin member counted */
	maxFilterValues?: number
	maxInValues?: number
	/** Bytes one `filter` may take however a client encodes it (U28), beside its character cap */
	maxFilterBytes?: number
	/** Bytes the whole query string comb accepts takes at most, however a client encodes it: 16 KB less a 2 KB path budget */
	maxQueryBytes?: number
	/** Whitespace-separated words one `q` may hold */
	maxSearchTerms?: number
	/** Bytes one `q` may take however a client encodes it */
	maxSearchBytes?: number
	maxSortKeys?: number
	/** null = not knowable at this layer, which is not the same as "none" (docs §6.1) */
	searchable: string[] | null
	selectable: string[]
	maxLimit: number
	/** The last page offset pagination serves; past it, a client pages by cursor */
	maxPage?: number
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

export {
	COMB_FILTER_GRAMMAR,
	COMB_META_KEY,
	COMB_META_VERSION,
	type CombEntityMeta,
	type CombEntityMetaInput,
	type CombFilterField,
	type CombFilterGrammar,
	type CombMeta,
	type CombMetaInput,
	type CombMetaKind,
	type CombMetaStamp,
	type CombQueryMeta,
	type CombQueryMetaInput,
	type CombStatesMeta,
	type UniqueIndexMeta,
}
