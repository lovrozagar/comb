/** The options the SQLite list builders take, and the query they build (build-list-query.ts). Declarations only. */
import type { SQL, SQLWrapper } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import type { ListPagination } from "../pagination.ts"
import type { ComputedFilterResolver, ComputedSortResolver, ListQueryInput } from "../types.ts"
import type { LikeSearchResolver } from "./search.ts"
import type { RelationConfig } from "./types.ts"

type BuildListQueryOpts<TTable extends SQLiteTable> = {
	/** Additional WHERE clause ANDed with filter/cursor — for joins, access filters, soft deletes */
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL) | undefined
	computedFilters?: Record<string, ComputedFilterResolver> | undefined
	computedSorts?: Record<string, ComputedSortResolver> | undefined
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
	relations?: Record<string, RelationConfig> | undefined
	/** LIKE-based search resolver — use `likeSearch(column)` factory */
	search?: LikeSearchResolver | undefined
	table: TTable
}

type BuildDerivedListQueryOpts<TSortField extends string = string> = {
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL) | undefined
	/** the list's scope, its route and tenant: a cursor minted in another opens in none here */
	cursorScope: string
	/** the app's secret a cursor is sealed under, of at least 32 UTF-8 bytes */
	cursorSecret: string
	/**
	 * the database the list reads, needed only where its id and keys hold no column: a column says it
	 * wherever it sits, and a list of SQL expressions alone (a union, say) cannot (Q1 of r21)
	 */
	dialect?: "postgres" | "sqlite" | undefined
	filterWhere?: SQL | null | undefined
	/**
	 * Present when the rows come from several shards, which paginateMerged merges, as on
	 * buildListQuery: each shard reads its window, an offset page its count. A merged derived list
	 * carries no sort key by reference, and its rows carry each sort field under its name (Q12 of r18).
	 */
	merged?: { maxRowsPerShard?: number | undefined } | undefined
	parsed: ListQueryInput<TSortField>
	searchWhere?: SQL | null | undefined
	/** each sort field's expression; one that yields epoch milliseconds is `{ sql, type: "date" }`, and its cursor value a Date */
	sortColumns: Record<TSortField, SQLWrapper | { sql: SQLWrapper; type: "date" }>
} & (
	| {
			/**
			 * the one table the rows are, by its id column: a sort key too long for a cursor is
			 * carried by reference and read back from it, as on a table's own list (C3)
			 */
			anchor: { idColumn: SQLiteColumn; table: SQLiteTable }
			idColumn?: never | undefined
	  }
	| {
			anchor?: never | undefined
			/** the id the order breaks ties on; with no table to read a key back from, a key too long for a cursor is a 500 */
			idColumn: SQLWrapper
	  }
)

/**
 * The columns a built list's rows must carry beside the app's own, for `paginate` to read: select
 * them with the rest (`db.select({ ...cols, ...built.extras })`), and paginate strips them (Q2)
 */
/* each key absent or set, never undefined, so the extras go on to drizzle's select as they are */
type ListExtras = Partial<{
	/** 1 when the cursor's anchor row is gone where no bound is safe, which paginate answers invalid_cursor (U26) */
	_combAnchorGone: SQL.Aliased<number>
	/** the value the list breaks ties on, which the next cursor resumes from; none when no cursor can */
	_combId: SQL.Aliased<unknown>
	/** the class of each sort key and the tiebreak, comma-joined, where the list binds them as read or one is an undeclared SQLite expression (Q2 of r19, Q2 of r21) */
	_combKeyTypes: SQL.Aliased<string>
	/** each sort key's stored time where the list binds it as read, comma-joined, empty for any other key: a Postgres time key's text, a SQLite REAL seconds (QL2 of r22b) */
	_combKeyTexts: SQL.Aliased<string>
	/** an offset page's count of every row the filter matches; a cursor page selects none (keyset avoids it) */
	_total: SQL.Aliased<number>
}>

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
