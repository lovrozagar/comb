/** The options the SQLite list builders take, and the query they build. Declarations only. */
import type { SQL, SQLWrapper } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import type { ListPagination } from "../pagination.ts"
import type { ComputedFilterResolver, ComputedSortResolver, ListQueryInput } from "../types.ts"
import type { LikeSearchResolver } from "./search.ts"
import type { RelationConfig } from "./types.ts"

/** What `buildListQuery` builds a table's list from */
type BuildListQueryOpts<TTable extends SQLiteTable> = {
	/** a WHERE clause ANDed with the filter, search and cursor, for joins, access rules or soft deletes; a function is called with drizzle's `sql` */
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL) | undefined
	/** the resolver of each `@`-prefixed filter field, by its name with the `@`; a filter on one without a resolver is a 500 */
	computedFilters?: Record<string, ComputedFilterResolver> | undefined
	/** the resolver of each `@`-prefixed sort field, by its name with the `@`; a sort on one without a resolver is a 500 */
	computedSorts?: Record<string, ComputedSortResolver> | undefined
	/** the list's scope, its route and tenant: a cursor minted in another opens in none here */
	cursorScope: string
	/** the app's secret a cursor is sealed under, of at least 32 UTF-8 bytes */
	cursorSecret: string
	/** "exact" when the driver reads ±Infinity back as Infinity, so a null cursor is a real NULL, as on `CursorOptions` */
	nonFinite?: "exact" | undefined
	// K5 of r17
	/**
	 * Present for a list whose rows sit on several D1 shards: every shard reads it with this one
	 * query, and `paginateMerged` merges what they read. A page by number reads every row to its end
	 * from each shard. It sorts by columns only, and the table needs an `id` column to break ties across shards
	 */
	merged?:
		| {
				/** the most rows a shard reads for one page by number, a whole number from 1; default 1001, and a deeper page is a 400 `page_too_deep` */
				maxRowsPerShard?: number | undefined
		  }
		| undefined
	/** the list schema's output; a filter or order it did not check is a 500 */
	parsed: ListQueryInput
	/** the many-to-many relation each `relation.column` filter field reaches, by the relation's name */
	relations?: Record<string, RelationConfig> | undefined
	/** the search the `q` param runs, such as `likeSearch(column)`; a `q` without one is a 500 */
	search?: LikeSearchResolver | undefined
	/** the table the list reads; each sort and filter field is one of its columns by property name, and its `id` column breaks ties */
	table: TTable
}

/** What `buildDerivedListQuery` builds a list from whose rows are no one table's: a join, a union or a view */
type BuildDerivedListQueryOpts<TSortField extends string = string> = {
	/** a WHERE clause ANDed with the filter, search and cursor; a function is called with drizzle's `sql` */
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL) | undefined
	/** the list's scope, its route and tenant: a cursor minted in another opens in none here */
	cursorScope: string
	/** the app's secret a cursor is sealed under, of at least 32 UTF-8 bytes */
	cursorSecret: string
	// Q1 of r21
	/**
	 * the database the list reads, needed only where its id and keys hold no column: a column says it
	 * wherever it sits, and a list of SQL expressions alone (a union, say) cannot
	 */
	dialect?: "postgres" | "sqlite" | undefined
	/** the request's filter as SQL, lowered by your code; null or absent filters nothing */
	filterWhere?: SQL | null | undefined
	// Q12 of r18
	/**
	 * Present when the rows come from several shards, which `paginateMerged` merges, as on
	 * `buildListQuery`: each shard reads its window, an offset page its count. A merged derived list
	 * carries no sort key by reference, so it takes `idColumn`, and its rows carry each sort field under its name
	 */
	merged?:
		| {
				/** the most rows a shard reads for one page by number, a whole number from 1; default 1001, and a deeper page is a 400 `page_too_deep` */
				maxRowsPerShard?: number | undefined
		  }
		| undefined
	/** the list schema's output; its sort fields are the keys of `sortColumns` */
	parsed: ListQueryInput<TSortField>
	/** the request's search as SQL, built by your code; null or absent searches nothing */
	searchWhere?: SQL | null | undefined
	/** each sort field's expression; one that yields epoch milliseconds is `{ sql, type: "date" }`, and its cursor value a Date. A sort on a field with none is a 500 */
	sortColumns: Record<
		TSortField,
		| SQLWrapper
		| {
				/** the expression, yielding epoch milliseconds */
				sql: SQLWrapper
				/** "date": the cursor carries the key as a Date */
				type: "date"
		  }
	>
} & (
	| {
			// C3
			/**
			 * the one table the rows are, by its id column: a sort key too long for a cursor is
			 * carried by reference and read back from it, as on a table's own list
			 */
			anchor: {
				/** the table's id column, which the order breaks ties on */
				idColumn: SQLiteColumn
				/** the table each row is one of */
				table: SQLiteTable
			}
			/** absent: `anchor` names the id */
			idColumn?: never | undefined
	  }
	| {
			/** absent: the rows are no one table's */
			anchor?: never | undefined
			/** the id the order breaks ties on; with no table to read a key back from, a key too long for a cursor is a 500 */
			idColumn: SQLWrapper
	  }
)

// Q2
/**
 * The columns a built list's rows must carry beside the app's own, for `paginate` to read: select
 * them with the rest (`db.select({ ...cols, ...built.extras })`), and paginate strips them
 */
/* each key absent or set, never undefined, so the extras go on to drizzle's select as they are */
type ListExtras = Partial<{
	// U26
	/** 1 when the cursor's anchor row is gone where no bound is safe, which paginate answers with a 400 invalid_cursor */
	_combAnchorGone: SQL.Aliased<number>
	/** the value the list breaks ties on, which the next cursor resumes from; none when no cursor can */
	_combId: SQL.Aliased<unknown>
	// Q2 of r19, Q2 of r21
	/** the class of each sort key and the tiebreak, comma-joined, where the list binds them as read or one is an undeclared SQLite expression */
	_combKeyTypes: SQL.Aliased<string>
	// QL2 of r22b
	/** each sort key's stored time where the list binds it as read, comma-joined, empty for any other key: a Postgres time key's text, a SQLite REAL seconds */
	_combKeyTexts: SQL.Aliased<string>
	// B2-3 of area B
	/** each SQLite timestamp key's TEXT where the list reads it back and the row holds TEXT, a JSON array with null for any other key */
	_combTextKeys: SQL.Aliased<string>
	/** an offset page's count of every row the filter matches; a cursor page selects none */
	_total: SQL.Aliased<number>
}>

/** A built list query: apply it with `applyListQuery`, then page its rows with `paginate` */
type ListQueryResult = {
	/** select these beside the row's own columns */
	extras: ListExtras
	/** the rows to read: one more than the page, so `paginate` can tell a next page exists */
	limit: number
	/** How `paginate` pages the rows this query reads */
	pagination: ListPagination & {
		/** false: `paginate` pages it */
		merged: false
	}
	/** the page as the request asked for it */
	meta: {
		/** the page size */
		limit: number
		/** the page number; 1 on a cursor page */
		page: number
		/** how the page is read: past a cursor, or by number */
		type: "cursor" | "offset"
	}
	/** the rows to skip: 0 on a cursor page, which the WHERE clause seeks past */
	offset: number
	/** the ORDER BY: each sort key with its null placement stated, then the tiebreak */
	orderBy: SQL[]
	/** the trimmed search text; null when the request searches nothing */
	search: string | null
	/** the base, filter, search and cursor clauses ANDed; undefined when there are none */
	where: SQL | undefined
}

// K8 of r17
/** A merged list's query, which every shard reads and `paginateMerged` alone pages; each shard reads from its first row, so `offset` is 0 */
type MergedListQueryResult = Omit<ListQueryResult, "pagination"> & {
	/** How `paginateMerged` pages the rows every shard reads */
	pagination: ListPagination & {
		/** true: `paginateMerged` pages it, and `paginate` refuses it */
		merged: true
	}
}

export type { BuildDerivedListQueryOpts, BuildListQueryOpts, ListExtras, ListQueryResult, MergedListQueryResult }
