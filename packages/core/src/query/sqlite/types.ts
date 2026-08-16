/**
 * SQLite-specific query types.
 */
import type { SQL } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"

import type {
	ComputedFilterResolver,
	ComputedSortResolver,
	ListQueryCapabilities,
	ListQueryInput,
	SortDirection,
} from "../types.ts"

type RelationConfig = {
	target: SQLiteTable
	targetKey: string
	through: SQLiteTable
	throughKey: string
}

type QueryExecutorConfig<TTable extends SQLiteTable> = {
	capabilities: ListQueryCapabilities
	computedFilters?: Record<string, ComputedFilterResolver> | undefined
	computedSorts?: Record<string, ComputedSortResolver> | undefined
	ftsTable?: SQLiteTable
	input: ListQueryInput
	mainIdColumn?: SQLiteColumn
	relations?: Record<string, RelationConfig> | undefined
	table: TTable
}

type QueryExecutorResult = {
	cursor: {
		direction: SortDirection
		idColumn: SQLiteColumn
		idValue: string
		sortColumn: SQLiteColumn
		sortValue: unknown
	} | null
	limit: number
	meta: {
		limit: number
		page: number
		type: "cursor" | "offset"
	}
	offset: number
	orderBy: SQL[]
	search: string | null
	where: SQL | null
}

export type { QueryExecutorConfig, QueryExecutorResult, RelationConfig }
