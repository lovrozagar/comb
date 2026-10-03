import { and, getTableColumns, sql, type SQL, type SQLWrapper } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import { CURSOR_TIEBREAK_COLUMN, DEFAULT_SORT, readCursor } from "../cursor.ts"
import type { ComputedFilterResolver, ComputedSortResolver, FilterAST, SortField } from "../types.ts"
import { filterToSQL } from "./executor.ts"
import { keysetSQL, orderByKeys, orderSQL, type SortKey } from "./keyset.ts"
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
	parsedSort: SortField[]
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
		parsedSort: SortField<TSortField>[]
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

function combineWhere(...clauses: (SQL | null | undefined)[]): SQL | undefined {
	const valid = clauses.filter((c): c is SQL => c !== null && c !== undefined)
	if (valid.length === 0) return undefined
	if (valid.length === 1) return valid[0]
	return and(...valid)
}

function resolveBaseWhere(baseWhere: BuildListQueryOpts<SQLiteTable>["baseWhere"]): SQL | undefined {
	return typeof baseWhere === "function" ? baseWhere(sql) : baseWhere
}

type Keyset = {
	/** Present only when every key is a real column a predicate can compare. */
	keys: SortKey[] | null
	orderBy: SQL[]
}

/**
 * Shared tail of both builders: cursor predicate, pagination mode, result shape.
 * `keys` null means the order includes something keyset cannot express.
 */
function finish(
	parsed: ListQueryParsed,
	sort: readonly SortField[],
	keyset: Keyset,
	tiebreak: SortKey | null,
	where: Array<SQL | null | undefined>,
): ListQueryResult {
	const search = parsed.q?.trim() || null

	if (parsed.cursor) {
		if (!keyset.keys || !tiebreak) {
			throw new CombError({
				cause: "Cursor pagination needs every sort key to be a column; use page instead",
				errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
				status: "bad_request",
			})
		}
		const cursor = readCursor(parsed.cursor, sort)
		const after = keysetSQL(keyset.keys, cursor.values, tiebreak, cursor.id)
		return {
			limit: parsed.limit + 1,
			meta: { limit: parsed.limit, page: 1, type: "cursor" },
			offset: 0,
			orderBy: keyset.orderBy,
			search,
			where: combineWhere(...where, after),
		}
	}

	const page = parsed.page ?? 1
	return {
		limit: parsed.limit + 1,
		meta: { limit: parsed.limit, page, type: "offset" },
		offset: (page - 1) * parsed.limit,
		orderBy: keyset.orderBy,
		search,
		where: combineWhere(...where),
	}
}

function buildListQuery<TTable extends SQLiteTable>(opts: BuildListQueryOpts<TTable>): ListQueryResult {
	const { parsed, table } = opts
	const columns = getTableColumns(table) as Record<string, SQLiteColumn>
	const sort = parsed.parsedSort.length > 0 ? parsed.parsedSort : DEFAULT_SORT.filter(({ field }) => columns[field])

	const idColumn = columns[CURSOR_TIEBREAK_COLUMN]
	if (parsed.cursor && !idColumn) {
		/* Without a tiebreak column there is no predicate to add, and ignoring the
		   cursor would quietly re-serve the first page. This is a schema mistake. */
		throw new CombError({
			cause: `Table has no "${CURSOR_TIEBREAK_COLUMN}" property to break ties on`,
			errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
			status: "internal_server_error",
		})
	}

	const primaryDirection = sort[0]?.direction ?? "desc"
	const tiebreak: SortKey | null = idColumn ? { column: idColumn, direction: primaryDirection } : null
	const keys: SortKey[] = []
	const orderBy: SQL[] = []
	let keysetable = tiebreak !== null
	for (const { direction, field, nulls } of sort) {
		if (field.startsWith("@")) {
			const resolver = opts.computedSorts?.[field]
			if (resolver) orderBy.push(resolver(direction))
			keysetable = false
			continue
		}
		const column = columns[field]
		if (!column) {
			keysetable = false
			continue
		}
		const key = { column, direction, nulls }
		keys.push(key)
		orderBy.push(orderSQL(key))
	}
	if (tiebreak) orderBy.push(orderSQL(tiebreak))

	const q = parsed.q?.trim()
	if (q && !opts.search) {
		/* The schema accepted `q`, so the endpoint promised search. Dropping it
		   would answer every query with the unfiltered list. */
		throw new CombError({
			cause: "Request carries q but buildListQuery got no search resolver",
			errorKey: combErrorKeys.SEARCH_NOT_WIRED,
			status: "internal_server_error",
		})
	}

	return finish(parsed, sort, { keys: keysetable ? keys : null, orderBy }, tiebreak, [
		resolveBaseWhere(opts.baseWhere),
		buildFilterWhere(parsed.filterAst, table, opts),
		q && opts.search ? opts.search(q) : null,
	])
}

function buildDerivedListQuery<TSortField extends string>(
	opts: BuildDerivedListQueryOpts<TSortField>,
): ListQueryResult {
	const sort = opts.parsed.parsedSort
	const keys: SortKey[] = []
	let keysetable = true
	for (const { direction, field, nulls } of sort) {
		const column = opts.sortColumns[field]
		if (column) keys.push({ column, direction, nulls })
		else keysetable = false
	}

	const tiebreak: SortKey = { column: opts.idColumn, direction: sort[0]?.direction ?? "desc" }
	const orderBy = orderByKeys(keys, tiebreak)

	return finish(opts.parsed, sort, { keys: keysetable ? keys : null, orderBy }, tiebreak, [
		resolveBaseWhere(opts.baseWhere),
		opts.filterWhere,
		opts.searchWhere,
	])
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
