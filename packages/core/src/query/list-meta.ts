/**
 * The query facts a list query schema publishes on `x-comb`. Every value comes from the config
 * that parses the request, so the published facts cannot drift from behavior (docs §6).
 */
import { COMB_FILTER_GRAMMAR, combMeta } from "../meta.ts"
import { EMPTY_OBJ } from "../types.ts"
import { CURSOR_TIEBREAK_COLUMN } from "./cursor.ts"
import { OPERATORS_BY_TYPE } from "./filter.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"
import type { FieldsConfig, ListQueryConfig, ListQueryLimits } from "./schema-types.ts"
import type { FieldType } from "./types.ts"

type PublishedConfig = Pick<ListQueryConfig, "fields" | "filter" | "pagination" | "search" | "sort">

/**
 * The order applied when a request names none. Mirrors the transform:
 * first declared sort field, descending.
 */
function buildDefaultOrder(sortConfig: readonly string[]): string {
	const first = sortConfig[0]
	return first ? `${first}.desc` : ""
}

/**
 * Fields a consumer may name directly in `select`.
 *
 * Scalars only. A relation is selectable exclusively in the `author(name)`
 * form — the bare name parses as a scalar and is rejected — so publishing
 * relation names here would invite a consumer to send `select=author` and take
 * the 400 as a finding.
 */
function selectableFrom(fieldsConfig: FieldsConfig | undefined): string[] {
	return fieldsConfig ? [...fieldsConfig.scalars] : []
}

/** The `x-comb` stamp of a list query schema built from `config` under `limits` */
function listQueryStamp(config: PublishedConfig, limits: ListQueryLimits) {
	const filterConfig: Record<string, FieldType> = config.filter ?? EMPTY_OBJ
	return combMeta({
		defaultOrder: buildDefaultOrder(config.sort),
		filterFields: Object.entries(filterConfig).map(([field, type]) => ({
			field,
			ops: [...OPERATORS_BY_TYPE[type]],
			type,
		})),
		filterable: Object.keys(filterConfig),
		grammar: COMB_FILTER_GRAMMAR,
		kind: "query",
		maxFilterConditions: limits.maxConditions,
		maxFilterDepth: limits.maxDepth,
		maxFilterValues: limits.maxValues,
		maxInValues: limits.maxInValues,
		maxLimit: config.pagination?.maxLimit ?? PAGINATION_DEFAULTS.maxLimit,
		maxSearchTerms: limits.maxSearchTerms,
		maxSortKeys: limits.maxSortKeys,
		nulls: ["first", "last"],
		/* Declared, and enforced at buildListQuery: a `q` with no resolver
		   throws there instead of being ignored. See docs §6.1. */
		searchable: config.search ? [...config.search] : [],
		selectable: selectableFrom(config.fields),
		sortable: [...config.sort],
		stableTiebreak: CURSOR_TIEBREAK_COLUMN,
	})
}

export { buildDefaultOrder, listQueryStamp, selectableFrom }
