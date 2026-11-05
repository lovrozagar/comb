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
 * Throw a 400 for a page that is not a whole number from 1, which would bind a negative or
 * fractional offset, or that passes the default maxPage: an offset that deep makes the database
 * skip every row before it, which a list schema refuses. A schema's output states its own
 * maxPage as `pageBound`, which replaces the default here, so a spread of it stays held to that
 * number; `validated` says the filter and the order were checked, never the page.
 */
function assertPageWithin(parsed: {
	page?: number | null | undefined
	pageBound?: number | undefined
	/** the filter's and the order's check, which says nothing of the page: not read here */
	validated?: true | undefined
}): void {
	const page = parsed.page ?? 1
	if (!Number.isInteger(page) || page < 1) throw invalidPage(page)
	const bound = parsed.pageBound ?? PAGINATION_DEFAULTS.maxPage
	if (!(page <= bound)) throw pageTooDeep(page, bound)
}

/**
 * Throw a 400 for a limit that is not a whole number from 1, which reaches LIMIT and OFFSET as a
 * page does; a schema's own limit is one already. The key is the page's, so an app's
 * map of error keys needs no new one
 */
function assertLimitWithin(parsed: { limit: number; limitBound?: number | undefined }): void {
	if (!Number.isInteger(parsed.limit) || parsed.limit < 1) {
		throw new CombError({
			cause: `limit ${String(parsed.limit)} is not a whole number from 1`,
			errorKey: combErrorKeys.INVALID_PAGE,
			status: "bad_request",
		})
	}
	/* a limit no schema bounded is held to the default maxLimit, as such a page is to maxPage */
	const bound = parsed.limitBound ?? PAGINATION_DEFAULTS.maxLimit
	if (parsed.limit <= bound) return
	throw new CombError({
		cause: `limit ${parsed.limit} is past ${bound}; page by cursor, or bound it in the list schema`,
		errorKey: combErrorKeys.INVALID_PAGE,
		status: "bad_request",
	})
}

/** The 400 for a page that is no whole number from 1, from a list schema or from a builder */
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
