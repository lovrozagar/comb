/* The 500s and 400s paginate and paginateMerged answer before they page: a call wired wrong, or a list past a gone anchor */
import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { malformed, unencoded } from "./list-extras.ts"
import type { ListPagination } from "./pagination.ts"

/**
 * Rows that lack an extra their builder selected were read without the built query's extras, and
 * an absent flag or count would be read as none: a page_not_wired, whether or not the page needs
 * it yet (Q3 of r17)
 */
function refuseUnwired(items: readonly object[], pagination: ListPagination): void {
	const missing = pagination.expects.filter((key) => items.some((item) => !Object.hasOwn(item, key)))
	if (missing.length > 0) {
		throw new CombError({
			cause: `the rows carry no ${missing.join(", ")}: select the built query's extras beside your columns (db.select({ ...columns, ...built.extras }), or findMany({ extras: built.extras }))`,
			errorKey: combErrorKeys.PAGE_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	const wrong = items.map((item) => malformed(item, pagination.parsedSort)).find((what) => what !== undefined)
	if (wrong === undefined) return
	throw new CombError({
		cause: `the rows carry ${wrong}, no value the built query selects: render each extra into raw SQL as sql\`\${extra.sql} AS \${sql.identifier(extra.fieldAlias)}\`, or select the built query's extras beside your columns`,
		errorKey: combErrorKeys.PAGE_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** Read before anything else, _total included: a list past a gone anchor is no page of it (U26) */
function refuseGoneAnchor(items: readonly object[]): void {
	if (
		items.some((item) =>
			[1, 1n, true].includes(unencoded((item as Record<string, unknown>)["_combAnchorGone"]) as never),
		)
	) {
		throw new CombError({
			cause:
				"the row this cursor resumes from was renamed or deleted, and no bound is safe under its collation; start the list again",
			errorKey: combErrorKeys.INVALID_CURSOR,
			status: "bad_request",
		})
	}
}

/**
 * `built` as paginate (or, `merged`, paginateMerged) takes it, or a 500 naming the call: a parsed
 * query in its place is the call before 0.15, and a merged list's pages are paginateMerged's alone
 */
function paginationIn<TMerged extends boolean>(
	built: { pagination: ListPagination & { merged: TMerged } } | undefined,
	merged: TMerged,
): ListPagination & { merged: TMerged } {
	const pagination = (built as { pagination?: (ListPagination & { merged: TMerged }) | undefined } | undefined)
		?.pagination
	if (pagination === undefined) {
		throw new CombError({
			cause:
				"paginate takes the built query (buildListQuery, buildDerivedListQuery or queryHelpers.listOptions) in place of the parsed query and cursor options it took before 0.15",
			errorKey: combErrorKeys.PAGE_NOT_WIRED,
			status: "internal_server_error",
		})
	}
	if (pagination.merged === merged) return pagination
	throw new CombError({
		cause: merged
			? "paginateMerged pages a list buildListQuery built with `merged`; a single database's list goes to paginate"
			: "a list buildListQuery built with `merged` is paged by paginateMerged, over every shard's rows",
		errorKey: combErrorKeys.PAGE_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** More rows than the built query reads are rows of another query: one that applied no limit (C2) */
function refuseOverRead(count: number, pagination: ListPagination): void {
	if (count <= pagination.window) return
	throw new CombError({
		cause: `paginate got ${count} rows where the built query reads at most ${pagination.window}: apply its limit and offset (applyListQuery does)`,
		errorKey: combErrorKeys.PAGE_NOT_WIRED,
		status: "internal_server_error",
	})
}

export { paginationIn, refuseGoneAnchor, refuseOverRead, refuseUnwired }
