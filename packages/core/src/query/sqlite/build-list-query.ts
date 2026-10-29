import { getTableColumns, sql, type SQL } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { own } from "../../constraint-map.ts"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import { CURSOR_TIEBREAK_COLUMN } from "../cursor.ts"
import type { ComputedSortResolver, FilterAST, SortField } from "../types.ts"
import { filterToSQL } from "./executor.ts"
import { assertSchemaParsed } from "../trusted.ts"
import { DateKey } from "./cursor-fit.ts"
import { orderByKeys, orderSQL, type SortKey } from "./keyset.ts"
import { finish, type Keyset } from "./list-finish.ts"
import type { LikeSearchResolver } from "./search.ts"
import type {
	BuildDerivedListQueryOpts,
	BuildListQueryOpts,
	ListExtras,
	ListQueryResult,
	MergedListQueryResult,
} from "./build-list-query-types.ts"

function isFilterAST(v: unknown): v is FilterAST {
	return typeof v === "object" && v !== null && "root" in v
}

function buildFilterWhere(
	filterAst: FilterAST | null | unknown,
	table: SQLiteTable,
	opts: BuildListQueryOpts<SQLiteTable>,
): SQL | null {
	if (!filterAst || !isFilterAST(filterAst)) return null

	return filterToSQL(filterAst, {
		computedFilters: opts.computedFilters,
		mainTable: table,
		relations: opts.relations,
	})
}

function resolveBaseWhere(baseWhere: BuildListQueryOpts<SQLiteTable>["baseWhere"]): SQL | undefined {
	return typeof baseWhere === "function" ? baseWhere(sql) : baseWhere
}

/** A sort the schema accepted but this table cannot run is a wiring mistake, not a reason to reorder */
function sortNotWired(field: string, missing: string): CombError {
	return new CombError({
		cause: `Sort on '${field}' has no ${missing} to run it`,
		errorKey: combErrorKeys.SORT_NOT_WIRED,
		status: "internal_server_error",
	})
}

/** The ORDER BY of `sort` and its keyset keys; keys are null once a computed sort is in the order */
function planSort(
	sort: readonly SortField[],
	columns: Record<string, SQLiteColumn>,
	computedSorts: Record<string, ComputedSortResolver> | undefined,
): Keyset {
	const keys: SortKey[] = []
	const orderBy: SQL[] = []
	let keysetable = true
	for (const { direction, field, nulls } of sort) {
		if (field.startsWith("@")) {
			const resolver = own(computedSorts, field)
			if (!resolver) throw sortNotWired(field, "resolver")
			orderBy.push(resolver(direction))
			keysetable = false
			continue
		}
		const column = own(columns, field)
		if (!column) throw sortNotWired(field, "column")
		const key = { column, direction, nulls }
		keys.push(key)
		orderBy.push(orderSQL(key))
	}
	return { keys: keysetable ? keys : null, orderBy }
}

/** The search predicate; a `q` the schema accepted with no resolver to run it is a wiring mistake */
function searchWhere(q: string | undefined, search: LikeSearchResolver | undefined): SQL | null {
	if (!q) return null
	if (search) return search(q)
	/* The schema accepted `q`, so the endpoint promised search. Dropping it
	   would answer every query with the unfiltered list. */
	throw new CombError({
		cause: "Request carries q but buildListQuery got no search resolver",
		errorKey: combErrorKeys.SEARCH_NOT_WIRED,
		status: "internal_server_error",
	})
}

function buildListQuery<TTable extends SQLiteTable>(
	opts: BuildListQueryOpts<TTable> & { merged: NonNullable<BuildListQueryOpts<TTable>["merged"]> },
): MergedListQueryResult
function buildListQuery<TTable extends SQLiteTable>(
	opts: BuildListQueryOpts<TTable> & { merged?: undefined },
): ListQueryResult
function buildListQuery<TTable extends SQLiteTable>(
	opts: BuildListQueryOpts<TTable>,
): ListQueryResult | MergedListQueryResult {
	const { parsed, table } = opts
	assertSchemaParsed(parsed)
	const columns = getTableColumns(table) as Record<string, SQLiteColumn>
	/* the schema decided the order: an empty sort orders by the tiebreak alone, as listOptions and paginate do */
	const sort = parsed.parsedSort

	const idColumn = own(columns, CURSOR_TIEBREAK_COLUMN)
	if (parsed.cursor && !idColumn) {
		/* Without a tiebreak column there is no predicate to add, and ignoring the
		   cursor would quietly re-serve the first page. This is a schema mistake. */
		throw new CombError({
			cause: `Table has no "${CURSOR_TIEBREAK_COLUMN}" property to break ties on`,
			errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
			status: "internal_server_error",
		})
	}

	const tiebreak: SortKey | null = idColumn ? { column: idColumn, direction: sort[0]?.direction ?? "desc" } : null
	const planned = planSort(sort, columns, opts.computedSorts)
	const keyset: Keyset = {
		keys: tiebreak ? planned.keys : null,
		orderBy: tiebreak ? [...planned.orderBy, orderSQL(tiebreak)] : planned.orderBy,
	}

	/*
	 * a merged list reads a null anchor as a real NULL (Q1 of the 0.14.1 review): its row is on one
	 * shard only, so every other reads it as gone, and resuming such a shard at -Infinity would repeat
	 * its rows. A row D1 reads back as null that holds ±Infinity comes back out of its shard's order,
	 * which paginateMerged refuses
	 */
	const nonFinite = opts.merged === undefined ? opts.nonFinite : "exact"
	/* finish built the pagination its `merged` says: a merged list's query is paged by paginateMerged alone */
	return finish({
		cursor: { cursorScope: opts.cursorScope, cursorSecret: opts.cursorSecret, nonFinite },
		keyset,
		merged: opts.merged,
		parsed,
		table,
		sort,
		tiebreak,
		where: [
			resolveBaseWhere(opts.baseWhere),
			buildFilterWhere(parsed.filterAst, table, opts),
			searchWhere(parsed.q?.trim(), opts.search),
		],
	}) as ListQueryResult | MergedListQueryResult
}

function buildDerivedListQuery<TSortField extends string>(
	opts: BuildDerivedListQueryOpts<TSortField>,
): ListQueryResult {
	const sort = opts.parsed.parsedSort
	/* a sort the schema accepted must order the rows: one with no column is a wiring mistake */
	const keys: SortKey[] = sort.map(({ direction, field, nulls }) => {
		const column = own(opts.sortColumns, field)
		if (!column) throw sortNotWired(field, "column")
		return { column: "type" in column ? new DateKey(column.sql) : column, direction, nulls }
	})

	const idColumn = opts.anchor === undefined ? opts.idColumn : opts.anchor.idColumn
	const tiebreak: SortKey = { column: idColumn, direction: sort[0]?.direction ?? "desc" }
	const orderBy = orderByKeys(keys, tiebreak)

	return finish({
		cursor: { cursorScope: opts.cursorScope, cursorSecret: opts.cursorSecret },
		keyset: { keys, orderBy },
		parsed: opts.parsed,
		sort,
		table: opts.anchor?.table,
		tiebreak,
		where: [resolveBaseWhere(opts.baseWhere), opts.filterWhere, opts.searchWhere],
	}) as ListQueryResult
}

export { applyListQuery } from "./apply-list-query.ts"
export {
	buildDerivedListQuery,
	buildListQuery,
	type BuildDerivedListQueryOpts,
	type BuildListQueryOpts,
	type ListExtras,
	type ListQueryResult,
	type MergedListQueryResult,
}
