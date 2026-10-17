/** Default page sizes and request bounds the list query schemas apply. */
import { FILTER_LIMITS } from "./filter.ts"
import type { ListQueryLimits } from "./schema-types.ts"

const PAGINATION_DEFAULTS = {
	defaultLimit: 20,
	maxLimit: 100,
} as const

/*
 * D1 binds at most 100 parameters per statement. The worst accepted request binds the filter's
 * maxValues (60), one per search word (8), the three-key keyset predicate (10) and limit and
 * offset (2): 80, which leaves 20 for the handler's own baseWhere.
 */
const LIST_QUERY_LIMITS: ListQueryLimits = {
	...FILTER_LIMITS,
	maxFilterLength: 2048,
	maxSearchTerms: 8,
	maxSortKeys: 3,
}

export { LIST_QUERY_LIMITS, PAGINATION_DEFAULTS }
