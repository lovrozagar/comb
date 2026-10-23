/**
 * The SQL builders take a filter and an order only from the list query schema, which checks them
 * against the fields an endpoint declares. A hand-built AST or sort would reach any column of the
 * table (an oracle on `password_hash` through `like`, or through the order rows come back in), so
 * the schema marks its output `validated: true` and the builders refuse a filter or an order
 * without it. Code that checked a filter against its own fields sets the flag itself.
 */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"

type Parsed = { filterAst?: unknown; parsedSort: readonly unknown[]; validated?: true | undefined }

const CAUSE =
	"takes createListQuerySchema's output; set validated: true only on a filter and order you checked yourself"

/** Throw a 500 when `parsed` carries a filter or an order that no schema checked */
function assertSchemaParsed(parsed: Parsed): void {
	if (parsed.validated === true) return
	if (parsed.filterAst !== null && parsed.filterAst !== undefined) {
		throw new CombError({
			cause: `The list query builder ${CAUSE}`,
			errorKey: combErrorKeys.FILTER_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	if (parsed.parsedSort.length > 0) {
		throw new CombError({
			cause: `The list query builder ${CAUSE}`,
			errorKey: combErrorKeys.SORT_NOT_WIRED,
			status: "internal_server_error",
		})
	}
}

/**
 * Throw a 400 for a page no schema bounded that is not a whole number from 1 (U5), which would bind
 * a negative or fractional offset, or that passes the default maxPage: an offset that deep makes the
 * database skip every row before it, which a list schema refuses (C4). A schema's own page, under
 * whatever maxPage it was built with, is trusted.
 */
function assertPageWithin(parsed: { page?: number | null | undefined; validated?: true | undefined }): void {
	if (parsed.validated === true) return
	const page = parsed.page ?? 1
	if (!Number.isInteger(page) || page < 1)
		throw new CombError({
			cause: `page ${page} is not a whole number from 1`,
			errorKey: combErrorKeys.INVALID_PAGE,
			status: "bad_request",
		})
	if (page <= PAGINATION_DEFAULTS.maxPage) return
	throw new CombError({
		cause: `page ${parsed.page} is past ${PAGINATION_DEFAULTS.maxPage}; page further by cursor`,
		errorKey: combErrorKeys.PAGE_TOO_DEEP,
		status: "bad_request",
	})
}

export { assertPageWithin, assertSchemaParsed }
