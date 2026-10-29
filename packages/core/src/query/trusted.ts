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
 * Throw a 400 for a page that is not a whole number from 1 (U5), which would bind a negative or
 * fractional offset, or that passes the default maxPage: an offset that deep makes the database
 * skip every row before it, which a list schema refuses (C4). Only a schema's own page, branded
 * `pageBounded` under whatever maxPage it was built with, skips that comparison; `validated` says
 * the filter and the order were checked, never the page (U29).
 */
function assertPageWithin(parsed: {
	page?: number | null | undefined
	pageBounded?: true | undefined
	/** the filter's and the order's check, which says nothing of the page: not read here */
	validated?: true | undefined
}): void {
	const page = parsed.page ?? 1
	if (!Number.isInteger(page) || page < 1) throw invalidPage(page)
	if (parsed.pageBounded !== true && page > PAGINATION_DEFAULTS.maxPage)
		throw pageTooDeep(page, PAGINATION_DEFAULTS.maxPage)
}

/**
 * Throw a 400 for a limit that is not a whole number from 1, which reaches LIMIT and OFFSET as a
 * page does (Q16 of r17); a schema's own limit is one already. The key is the page's, so an app's
 * map of error keys needs no new one
 */
function assertLimitWithin(parsed: { limit: number }): void {
	if (Number.isInteger(parsed.limit) && parsed.limit >= 1) return
	throw new CombError({
		cause: `limit ${String(parsed.limit)} is not a whole number from 1`,
		errorKey: combErrorKeys.INVALID_PAGE,
		status: "bad_request",
	})
}

/** The 400 for a page that is no whole number from 1, from a list schema or from a builder (U36) */
function invalidPage(page: unknown): CombError {
	return new CombError({
		cause: `page ${typeof page === "string" ? JSON.stringify(page) : String(page)} is not a whole number from 1`,
		errorKey: combErrorKeys.INVALID_PAGE,
		status: "bad_request",
	})
}

/** The 400 for a page past `maxPage`, from a list schema or from a list no schema bounded */
function pageTooDeep(page: number, maxPage: number): CombError {
	return new CombError({
		cause: `page ${page} is past ${maxPage}; page further by cursor`,
		errorKey: combErrorKeys.PAGE_TOO_DEEP,
		status: "bad_request",
	})
}

export { assertLimitWithin, assertPageWithin, assertSchemaParsed, invalidPage, pageTooDeep }
