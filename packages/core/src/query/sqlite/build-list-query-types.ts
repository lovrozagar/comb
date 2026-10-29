/** The options the SQLite list builders take, and the query they build (build-list-query.ts). Declarations only. */
import type { SQL, SQLWrapper } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import type { ListPagination } from "../pagination.ts"
import type { ComputedFilterResolver, ComputedSortResolver, ListQueryInput } from "../types.ts"
import type { LikeSearchResolver } from "./search.ts"
import type { RelationConfig } from "./types.ts"

type BuildListQueryOpts<TTable extends SQLiteTable> = {
	/** Additional WHERE clause ANDed with filter/cursor — for joins, access filters, soft deletes */
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL)
	computedFilters?: Record<string, ComputedFilterResolver>
	computedSorts?: Record<string, ComputedSortResolver>
	/** the list's scope, its route and tenant: a cursor minted in another opens in none here */
	cursorScope: string
	/** the app's secret a cursor is sealed under, of at least 32 UTF-8 bytes */
	cursorSecret: string
	/** "exact" when the driver reads ±Infinity back as Infinity, so a null cursor is a real NULL (CursorOptions) */
	nonFinite?: "exact" | undefined
	/**
	 * A list whose rows sit on several D1 shards: every shard reads it with this one query, and
	 * paginateMerged merges what they read (K5 of r17). A page by number reads every row to its end
	 * from each shard, past `maxRowsPerShard` (1001) a 400 `page_too_deep`
	 */
	merged?: { maxRowsPerShard?: number | undefined } | undefined
	parsed: ListQueryInput
	relations?: Record<string, RelationConfig>
	/** LIKE-based search resolver — use `likeSearch(column)` factory */
	search?: LikeSearchResolver
	table: TTable
}

type BuildDerivedListQueryOpts<TSortField extends string = string> = {
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL)
	/** the list's scope, its route and tenant: a cursor minted in another opens in none here */
	cursorScope: string
	/** the app's secret a cursor is sealed under, of at least 32 UTF-8 bytes */
	cursorSecret: string
	filterWhere?: SQL | null
	parsed: ListQueryInput<TSortField>
	searchWhere?: SQL | null
	/** each sort field's expression; one that yields epoch milliseconds is `{ sql, type: "date" }`, and its cursor value a Date */
	sortColumns: Record<TSortField, SQLWrapper | { sql: SQLWrapper; type: "date" }>
} & (
	| {
			/**
			 * the one table the rows are, by its id column: a sort key too long for a cursor is
			 * carried by reference and read back from it, as on a table's own list (C3)
			 */
			anchor: { idColumn: SQLiteColumn; table: SQLiteTable }
			idColumn?: never
	  }
	| {
			anchor?: never
			/** the id the order breaks ties on; with no table to read a key back from, a key too long for a cursor is a 500 */
			idColumn: SQLWrapper
	  }
)

/**
 * The columns a built list's rows must carry beside the app's own, for `paginate` to read: select
 * them with the rest (`db.select({ ...cols, ...built.extras })`), and paginate strips them (Q2)
 */
type ListExtras = {
	/** 1 when the cursor's anchor row is gone where no bound is safe, which paginate answers invalid_cursor (U26) */
	_combAnchorGone?: SQL.Aliased<number>
	/** the value the list breaks ties on, which the next cursor resumes from; none when no cursor can */
	_combId?: SQL.Aliased<unknown>
	/** an offset page's count of every row the filter matches; a cursor page selects none (keyset avoids it) */
	_total?: SQL.Aliased<number>
}

type ListQueryResult = {
	/** select these beside the row's own columns (ListExtras) */
	extras: ListExtras
	limit: number
	/** How `paginate` pages the rows this query reads (pagination.ts) */
	pagination: ListPagination & { merged: false }
	meta: { limit: number; page: number; type: "cursor" | "offset" }
	offset: number
	orderBy: SQL[]
	search: string | null
	where: SQL | undefined
}

/** A merged list's query, which every shard reads and paginateMerged alone pages (K8 of r17) */
type MergedListQueryResult = Omit<ListQueryResult, "pagination"> & { pagination: ListPagination & { merged: true } }

export type { BuildDerivedListQueryOpts, BuildListQueryOpts, ListExtras, ListQueryResult, MergedListQueryResult }
