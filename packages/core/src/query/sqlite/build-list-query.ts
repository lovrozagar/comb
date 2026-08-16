import { and, asc, desc, eq, getTableColumns, gt, lt, or, sql, type SQL, type SQLWrapper } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import { CURSOR_TIEBREAK_COLUMN, parseCursorForQuery } from "../cursor.ts"
import type { ComputedFilterResolver, ComputedSortResolver, FilterAST, SortField } from "../types.ts"
import { filterToSQL } from "./executor.ts"
import type { LikeSearchResolver } from "./search.ts"
import type { RelationConfig } from "./types.ts"

/**
 * Parsed list query input — matches createListQuerySchema output.
 * Intentionally loose to work with any codegen or manual construction.
 */
type ListQueryParsed = {
	cursor?: string | null
	filterAst?: FilterAST | null | unknown
	limit: number
	page?: number | null
	parsedSort: Array<{ direction: "asc" | "desc"; field: string }>
	q?: string | null
	[key: string]: unknown
}

type BuildListQueryOpts<TTable extends SQLiteTable> = {
	/** Additional WHERE clause ANDed with filter/cursor — for joins, access filters, soft deletes */
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL)
	computedFilters?: Record<string, ComputedFilterResolver>
	computedSorts?: Record<string, ComputedSortResolver>
	parsed: ListQueryParsed
	relations?: Record<string, RelationConfig>
	/** LIKE-based search resolver — use `likeSearch(column)` factory */
	search?: LikeSearchResolver
	table: TTable
}

type BuildDerivedListQueryOpts<TSortField extends string = string> = {
	baseWhere?: SQL | ((sql: (strings: TemplateStringsArray, ...values: unknown[]) => SQL) => SQL)
	filterWhere?: SQL | null
	idColumn: SQLWrapper
	parsed: ListQueryParsed & {
		parsedSort: Array<{ direction: "asc" | "desc"; field: TSortField }>
	}
	searchWhere?: SQL | null
	sortColumns: Record<TSortField, SQLWrapper>
}

type ListQueryResult = {
	limit: number
	meta: { limit: number; page: number; type: "cursor" | "offset" }
	offset: number
	orderBy: SQL[]
	search: string | null
	where: SQL | undefined
}

type ListQueryAppliable<TQuery> = {
	limit: (limit: number) => TQuery
	offset: (offset: number) => TQuery
	orderBy: (...orderBy: SQL[]) => TQuery
	where: (where: SQL) => TQuery
}

function buildOrderBy(
	table: SQLiteTable,
	parsedSort: SortField[],
	computedSorts?: Record<string, ComputedSortResolver>,
): SQL[] {
	const columns = getTableColumns(table)
	const orderBy: SQL[] = []

	if (parsedSort.length > 0) {
		for (const { direction, field } of parsedSort) {
			if (field.startsWith("@")) {
				const resolver = computedSorts?.[field]
				if (resolver) orderBy.push(resolver(direction))
				continue
			}
			const col = columns[field]
			if (col) {
				orderBy.push(direction === "asc" ? asc(col) : desc(col))
			}
		}
	} else {
		const createdAt = columns["created_at"]
		if (createdAt) {
			orderBy.push(desc(createdAt))
		}
	}

	/* id tiebreaker for stable sort */
	const idCol = columns[CURSOR_TIEBREAK_COLUMN]
	if (idCol && orderBy.length > 0) {
		const primaryDir = parsedSort[0]?.direction ?? "desc"
		orderBy.push(primaryDir === "desc" ? desc(idCol) : asc(idCol))
	}

	return orderBy
}

function isFilterAST(v: unknown): v is FilterAST {
	return typeof v === "object" && v !== null && "root" in v
}

function buildFilterWhere(
	filterAst: FilterAST | null | unknown,
	table: SQLiteTable,
	opts: BuildListQueryOpts<SQLiteTable>,
): SQL | null {
	if (!filterAst || !isFilterAST(filterAst)) return null

	/* Build permissive capabilities from table columns — schema already validated */
	const columns = getTableColumns(table)
	const filterFields: Record<string, "string"> = {}
	for (const key of Object.keys(columns)) {
		filterFields[key] = "string"
	}

	return filterToSQL(filterAst, {
		capabilities: {
			computedFilterFields: {},
			computedSortFields: new Set(),
			filterFields,
			pagination: { defaultLimit: 20, maxLimit: 100 },
			relationFilterFields: {},
			searchFields: new Set(),
			sortFields: new Set(),
		},
		computedFilters: opts.computedFilters,
		mainTable: table,
		relations: opts.relations,
	})
}

function buildCursorWhere(
	cursor: string | undefined,
	table: SQLiteTable,
	primarySortField: string,
	primarySortDirection: "asc" | "desc",
): SQL | null {
	if (!cursor) return null

	const parsed = parseCursorForQuery(cursor, primarySortDirection)
	if (!parsed) return null

	const columns = getTableColumns(table)
	const sortCol = columns[primarySortField] as SQLiteColumn | undefined
	const idCol = columns[CURSOR_TIEBREAK_COLUMN] as SQLiteColumn | undefined

	/* A cursor was supplied and decoded, so the caller is asking for keyset
	   pagination. Without a tiebreak column there is no predicate to add, and
	   returning null here would quietly re-serve the first page — rows duplicate
	   across pages and rows are skipped, with nothing to notice. Refuse loudly
	   instead: this is a schema mistake, not a runtime condition. */
	if (!idCol) {
		throw new CombError({
			cause: `Table has no "${CURSOR_TIEBREAK_COLUMN}" property to break ties on`,
			errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
			status: "internal_server_error",
		})
	}

	/* An unknown sort field is the query layer's business, not ours — it has
	   already been validated, and a cursor over a field this table lacks simply
	   has no predicate to express. */
	if (!sortCol) return null

	if (parsed.direction === "desc") {
		return or(lt(sortCol, parsed.sortValue), and(eq(sortCol, parsed.sortValue), lt(idCol, parsed.idValue))) ?? null
	}
	return or(gt(sortCol, parsed.sortValue), and(eq(sortCol, parsed.sortValue), gt(idCol, parsed.idValue))) ?? null
}

function buildDerivedOrderBy<TSortField extends string>(
	sortColumns: Record<TSortField, SQLWrapper>,
	idColumn: SQLWrapper,
	parsedSort: Array<{ direction: "asc" | "desc"; field: TSortField }>,
): SQL[] {
	const orderBy: SQL[] = []

	if (parsedSort.length > 0) {
		for (const { direction, field } of parsedSort) {
			const col = sortColumns[field]
			if (col) {
				/* NULLS LAST/FIRST ensures consistent ordering when column contains NULLs */
				orderBy.push(direction === "asc" ? sql`${col} ASC NULLS LAST` : sql`${col} DESC NULLS FIRST`)
			}
		}
	}

	const primaryDir = parsedSort[0]?.direction ?? "desc"
	orderBy.push(primaryDir === "desc" ? desc(idColumn) : asc(idColumn))

	return orderBy
}

function buildDerivedCursorWhere(
	cursor: string | undefined,
	sortColumn: SQLWrapper,
	idColumn: SQLWrapper,
	primarySortDirection: "asc" | "desc",
): SQL | null {
	if (!cursor) return null

	const parsed = parseCursorForQuery(cursor, primarySortDirection)
	if (!parsed) return null

	const { idValue, sortValue } = parsed

	if (parsed.direction === "desc") {
		if (sortValue === null) {
			/*
			 * DESC NULLS FIRST: NULLs appear first. A null cursor means we're
			 * already in the NULL zone — only advance within it, or jump to non-NULLs.
			 */
			return sql`(${sortColumn} IS NULL AND ${idColumn} < ${idValue}) OR ${sortColumn} IS NOT NULL`
		}
		return sql`(${sortColumn} < ${sortValue} OR (${sortColumn} = ${sortValue} AND ${idColumn} < ${idValue}))`
	}

	if (sortValue === null) {
		/*
		 * ASC NULLS LAST: NULLs appear last. A null cursor means we're in the
		 * NULL zone at the end — only advance within it.
		 */
		return sql`(${sortColumn} IS NULL AND ${idColumn} > ${idValue})`
	}
	return sql`(${sortColumn} > ${sortValue} OR (${sortColumn} = ${sortValue} AND ${idColumn} > ${idValue}) OR ${sortColumn} IS NULL)`
}

function combineWhere(...clauses: (SQL | null | undefined)[]): SQL | undefined {
	const valid = clauses.filter((c): c is SQL => c !== null && c !== undefined)
	if (valid.length === 0) return undefined
	if (valid.length === 1) return valid[0]
	return and(...valid) ?? undefined
}

function buildListQuery<TTable extends SQLiteTable>(opts: BuildListQueryOpts<TTable>): ListQueryResult {
	const { parsed, table } = opts
	const baseWhere = typeof opts.baseWhere === "function" ? opts.baseWhere(sql) : opts.baseWhere
	const orderBy = buildOrderBy(table, parsed.parsedSort, opts.computedSorts)
	const filterWhere = buildFilterWhere(parsed.filterAst, table, opts)
	const searchWhere = opts.search ? opts.search(parsed.q ?? "") : null

	const primarySortField = parsed.parsedSort[0]?.field ?? "created_at"
	const primarySortDirection = parsed.parsedSort[0]?.direction ?? "desc"

	/* Cursor pagination takes precedence */
	if (parsed.cursor) {
		const cursorWhere = buildCursorWhere(parsed.cursor, table, primarySortField, primarySortDirection)
		const where = combineWhere(baseWhere, filterWhere, cursorWhere, searchWhere)

		return {
			limit: parsed.limit + 1,
			meta: { limit: parsed.limit, page: 1, type: "cursor" },
			offset: 0,
			orderBy,
			search: parsed.q?.trim() ?? null,
			where,
		}
	}

	/* Page-based pagination */
	const page = parsed.page ?? 1
	const offset = (page - 1) * parsed.limit
	const where = combineWhere(baseWhere, filterWhere, searchWhere)

	return {
		limit: parsed.limit + 1,
		meta: { limit: parsed.limit, page, type: "offset" },
		offset,
		orderBy,
		search: parsed.q?.trim() ?? null,
		where,
	}
}

function buildDerivedListQuery<TSortField extends string>(
	opts: BuildDerivedListQueryOpts<TSortField>,
): ListQueryResult {
	const baseWhere = typeof opts.baseWhere === "function" ? opts.baseWhere(sql) : opts.baseWhere
	const orderBy = buildDerivedOrderBy(opts.sortColumns, opts.idColumn, opts.parsed.parsedSort)
	const primarySortField = opts.parsed.parsedSort[0]?.field
	const primarySortColumn = primarySortField ? opts.sortColumns[primarySortField] : undefined
	const primarySortDirection = opts.parsed.parsedSort[0]?.direction ?? "desc"

	if (opts.parsed.cursor && primarySortColumn) {
		const cursorWhere = buildDerivedCursorWhere(
			opts.parsed.cursor,
			primarySortColumn,
			opts.idColumn,
			primarySortDirection,
		)
		const where = combineWhere(baseWhere, opts.filterWhere, cursorWhere, opts.searchWhere)

		return {
			limit: opts.parsed.limit + 1,
			meta: { limit: opts.parsed.limit, page: 1, type: "cursor" },
			offset: 0,
			orderBy,
			search: opts.parsed.q?.trim() ?? null,
			where,
		}
	}

	const page = opts.parsed.page ?? 1
	const offset = (page - 1) * opts.parsed.limit
	const where = combineWhere(baseWhere, opts.filterWhere, opts.searchWhere)

	return {
		limit: opts.parsed.limit + 1,
		meta: { limit: opts.parsed.limit, page, type: "offset" },
		offset,
		orderBy,
		search: opts.parsed.q?.trim() ?? null,
		where,
	}
}

function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(query: TQuery, q: ListQueryResult) {
	const withWhere: TQuery = q.where ? query.where(q.where) : query

	return withWhere
		.orderBy(...q.orderBy)
		.limit(q.limit)
		.offset(q.offset)
}

export {
	applyListQuery,
	buildDerivedListQuery,
	buildListQuery,
	type BuildDerivedListQueryOpts,
	type BuildListQueryOpts,
	type ListQueryParsed,
	type ListQueryResult,
}
