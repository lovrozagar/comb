/** The one way a built list query reaches a drizzle select: its extras, WHERE, ORDER BY, LIMIT and OFFSET. */
import type { SQL } from "drizzle-orm"
import type { ListExtras, ListQueryResult } from "./build-list-query-types.ts"

/** A builder whose methods return its own type, as drizzle's select does once made dynamic */
type ListQueryAppliable<TQuery> = {
	limit: (limit: number) => TQuery
	offset: (offset: number) => TQuery
	orderBy: (...orderBy: SQL[]) => TQuery
	where: (where: SQL) => TQuery
}

/** What a built list, a single database's or a merged one's, reads with: its pagination is paginate's */
type ListQuery = Pick<ListQueryResult, "extras" | "limit" | "offset" | "orderBy" | "where">

/**
 * The select `select` builds over the built query's extras (the tiebreak, the count, the gone-anchor
 * flag paginate reads, K9 of r17), with the list's WHERE, ORDER BY, LIMIT and OFFSET applied:
 * drizzle's select as it is, made dynamic here, or a builder whose methods return its own type
 */
function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(
	select: (extras: ListExtras) => { $dynamic(): TQuery },
	q: ListQuery,
): TQuery
function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(
	select: (extras: ListExtras) => TQuery,
	q: ListQuery,
): TQuery
function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(
	select: (extras: ListExtras) => TQuery | { $dynamic(): TQuery },
	q: ListQuery,
): TQuery {
	const query = select(q.extras)
	const dynamic = "$dynamic" in query ? query.$dynamic() : query
	const withWhere: TQuery = q.where ? dynamic.where(q.where) : dynamic

	return withWhere
		.orderBy(...q.orderBy)
		.limit(q.limit)
		.offset(q.offset)
}

export { applyListQuery, type ListQueryAppliable }
