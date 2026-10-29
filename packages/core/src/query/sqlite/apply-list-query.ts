/** The one way a built list query reaches a drizzle select: its WHERE, ORDER BY, LIMIT and OFFSET. */
import type { SQL } from "drizzle-orm"
import type { ListQueryResult } from "./build-list-query.ts"

/** A builder whose methods return its own type, as drizzle's select does once made dynamic */
type ListQueryAppliable<TQuery> = {
	limit: (limit: number) => TQuery
	offset: (offset: number) => TQuery
	orderBy: (...orderBy: SQL[]) => TQuery
	where: (where: SQL) => TQuery
}

/**
 * `query` with the list's WHERE, ORDER BY, LIMIT and OFFSET applied: a builder whose methods return
 * its own type, or drizzle's select as it is, made dynamic here (C12 of the 0.14.1 review)
 */
function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(query: TQuery, q: ListQueryResult): TQuery
function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(
	query: { $dynamic(): TQuery },
	q: ListQueryResult,
): TQuery
function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(
	query: TQuery | { $dynamic(): TQuery },
	q: ListQueryResult,
): TQuery {
	const dynamic = "$dynamic" in query ? query.$dynamic() : query
	const withWhere: TQuery = q.where ? dynamic.where(q.where) : dynamic

	return withWhere
		.orderBy(...q.orderBy)
		.limit(q.limit)
		.offset(q.offset)
}

export { applyListQuery, type ListQueryAppliable }
