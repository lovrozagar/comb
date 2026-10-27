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
 * A URL limit counts bytes once percent-encoded: Cloudflare's is 16 KB. Of it 2 KB is left for the
 * path and the handler's own params, so the query string comb accepts stays within 14 KB however a
 * client encodes it (U28): the cursor's 8192, and these caps, measured the widest way.
 */
const URL_BYTES = 16_384
const PATH_BUDGET = 2048
const MAX_QUERY_BYTES: number = URL_BYTES - PATH_BUDGET
const REQUEST_BYTES = { filter: 4608, order: 200, q: 600, select: 500 } as const

/* the characters both a URL (encodeURIComponent) and a form (URLSearchParams) write as themselves */
const PLAIN = /^[\w*.-]$/
/* a UTF-16 surrogate without its pair, which no URL carries */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * `value`'s bytes as the widest common encoding writes it: a character either encoding escapes,
 * a space (%20 in a URL) and ~ or ! (%7E, %21 in a form) among them, as three per UTF-8 byte;
 * undefined for a lone surrogate, which no URL carries
 */
function encodedBytes(value: string): number | undefined {
	if (LONE_SURROGATE.test(value)) return undefined
	let bytes = 0
	for (const char of value) bytes += PLAIN.test(char) ? 1 : 3 * new TextEncoder().encode(char).length
	return bytes
}

/** Whether `value` takes at most `bytes` however a client encodes it */
const withinBytes =
	(bytes: number) =>
	(value: string): boolean =>
		(encodedBytes(value) ?? Number.POSITIVE_INFINITY) <= bytes

const encodedMessage = (bytes: number): string =>
	`At most ${bytes} bytes as a URL or a form encodes it, a space or a mark such as ~ counted as 3`

export {
	encodedBytes,
	encodedMessage,
	LIST_QUERY_LIMITS,
	MAX_QUERY_BYTES,
	PAGINATION_DEFAULTS,
	REQUEST_BYTES,
	withinBytes,
}
