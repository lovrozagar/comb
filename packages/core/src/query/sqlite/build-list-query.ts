import { and, getTableColumns, sql, type SQL, type SQLWrapper } from "drizzle-orm"
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { own } from "../../constraint-map.ts"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import { CURSOR_TIEBREAK_COLUMN, readCursor } from "../cursor.ts"
import type { ComputedFilterResolver, ComputedSortResolver, FilterAST, SortField } from "../types.ts"
import { filterToSQL } from "./executor.ts"
import { assertSchemaParsed } from "../trusted.ts"
import { assertCursorFits } from "./cursor-fit.ts"
import { keysetSQL, orderByKeys, orderSQL, type SortKey } from "./keyset.ts"
import type { LikeSearchResolver } from "./search.ts"
import type { RelationConfig } from "./types.ts"

/**
 * Parsed list query input — matches createListQuerySchema output.
 * Intentionally loose to work with any codegen or manual construction.
 */
type ListQueryParsed = {
	/* `| undefined` on each optional field: the list schema's output carries them as undefined, which
	   exactOptionalPropertyTypes otherwise refuses */
	cursor?: string | null | undefined
	filterAst?: FilterAST | null | unknown
	limit: number
	page?: number | null | undefined
	parsedSort: SortField[]
	q?: string | null | undefined
	/** The list schema sets it; a filter or an order without it is refused (query/trusted.ts) */
	validated?: true | undefined
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

	return filterToSQL(filterAst, {
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

type Finish = {
	keyset: Keyset
	parsed: ListQueryParsed
	sort: readonly SortField[]
	/** null when the table has no tiebreak column, so no cursor can be honored */
	tiebreak: SortKey | null
	where: Array<SQL | null | undefined>
}

/**
 * Shared tail of both builders: cursor predicate, pagination mode, result shape.
 * `keys` null means the order includes something keyset cannot express.
 */
function finish({ keyset, parsed, sort, tiebreak, where }: Finish): ListQueryResult {
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
		assertCursorFits([...keyset.keys.map(({ column }) => column), tiebreak.column], [...cursor.values, cursor.id])
		const after = keysetSQL({ id: cursor.id, keys: keyset.keys, tiebreak, values: cursor.values })
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

function buildListQuery<TTable extends SQLiteTable>(opts: BuildListQueryOpts<TTable>): ListQueryResult {
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

	return finish({
		keyset,
		parsed,
		sort,
		tiebreak,
		where: [
			resolveBaseWhere(opts.baseWhere),
			buildFilterWhere(parsed.filterAst, table, opts),
			searchWhere(parsed.q?.trim(), opts.search),
		],
	})
}

function buildDerivedListQuery<TSortField extends string>(
	opts: BuildDerivedListQueryOpts<TSortField>,
): ListQueryResult {
	const sort = opts.parsed.parsedSort
	/* a sort the schema accepted must order the rows: one with no column is a wiring mistake */
	const keys: SortKey[] = sort.map(({ direction, field, nulls }) => {
		const column = own(opts.sortColumns, field)
		if (!column) throw sortNotWired(field, "column")
		return { column, direction, nulls }
	})

	const tiebreak: SortKey = { column: opts.idColumn, direction: sort[0]?.direction ?? "desc" }
	const orderBy = orderByKeys(keys, tiebreak)

	return finish({
		keyset: { keys, orderBy },
		parsed: opts.parsed,
		sort,
		tiebreak,
		where: [resolveBaseWhere(opts.baseWhere), opts.filterWhere, opts.searchWhere],
	})
}

function applyListQuery<TQuery extends ListQueryAppliable<TQuery>>(query: TQuery, q: ListQueryResult): TQuery {
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
