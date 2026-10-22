/** Default page sizes and request bounds the list query schemas apply. */
import { FILTER_LIMITS } from "./filter.ts"
import type { ListQueryLimits } from "./schema-types.ts"

/* past maxPage, offset pagination makes the database skip more rows than a list should; cursors page on */
const PAGINATION_DEFAULTS = {
	defaultLimit: 20,
	maxLimit: 100,
	maxPage: 10_000,
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

/*
 * A URL limit counts bytes once percent-encoded (Cloudflare's is 16 KB), and one CJK character is
 * nine of them, so the free-text params are capped that way too. With the cursor's 8192 and order's
 * 200, the largest accepted query string stays near 15 KB, which leaves room for the path.
 */
const REQUEST_BYTES = { filter: 5120, q: 600 } as const

/** Whether `value` percent-encodes to at most `bytes`; a lone surrogate encodes to nothing, and no URL carries one */
const withinBytes =
	(bytes: number) =>
	(value: string): boolean => {
		try {
			return encodeURIComponent(value).length <= bytes
		} catch {
			// reason: encodeURIComponent throws URIError on a lone surrogate; such a value is refused
			return false
		}
	}

const encodedMessage = (bytes: number): string => `At most ${bytes} bytes once percent-encoded`

export { encodedMessage, LIST_QUERY_LIMITS, PAGINATION_DEFAULTS, REQUEST_BYTES, withinBytes }
