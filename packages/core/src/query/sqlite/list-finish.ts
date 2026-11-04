/**
 * The shared tail of the SQLite list builders (build-list-query.ts): the cursor predicate, the page
 * window, the extras every row carries for paginate, and the pagination descriptor that reads them.
 */
import { and, Column, is, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { SQLiteColumn, type SQLiteTable } from "drizzle-orm/sqlite-core"
import { CombError } from "../../error.ts"
import { combErrorKeys } from "../../types.ts"
import { type CursorOptions, NO_KEYSET_CAUSE } from "../cursor.ts"
import { assertCursorWired } from "../cursor-seal.ts"
import { COMB_ID, type ListExtra, type ListPagination, type PaginationFacts, paginationOf } from "../pagination.ts"
import type { ListDialect } from "../list-dialect.ts"
import { assertLimitWithin, assertPageWithin } from "../trusted.ts"
import type { ListQueryInput, SortField } from "../types.ts"
import type { ListExtras, ListQueryResult } from "./build-list-query-types.ts"
import { DateKey, inSeconds, readsBack, readsRounded, refersBack } from "./cursor-fit.ts"
import { cursorWhere } from "./cursor-where.ts"
import type { SortKey } from "./keyset.ts"

type Keyset = {
	/** Present only when every key is a real column a predicate can compare. */
	keys: SortKey[] | null
	orderBy: SQL[]
}

type Finish = {
	cursor: CursorOptions
	/** the database the list reads: a Postgres key is typed by its operand, a SQLite key by its storage class */
	dialect: ListDialect
	/** a list every shard reads, merged by paginateMerged (K5 of r17) */
	merged?: { maxRowsPerShard?: number | undefined } | undefined
	/** the table a cursor's references are read from; none on a derived list */
	table?: SQLiteTable | undefined
	keyset: Keyset
	parsed: ListQueryInput
	sort: readonly SortField[]
	/** null when the table has no tiebreak column, so no cursor can be honored */
	tiebreak: SortKey | null
	where: Array<SQL | null | undefined>
}

/** A built list before its pagination is told merged or not: buildListQuery's overloads tell it */
type Finished = Omit<ListQueryResult, "pagination"> & { pagination: ListPagination }

/* the rows a merged page may read from each shard by default: page × limit + 1, as deep as page 10 at 100 */
const MAX_ROWS_PER_SHARD = 1001

function combineWhere(...clauses: (SQL | null | undefined)[]): SQL | undefined {
	const valid = clauses.filter((c): c is SQL => c !== null && c !== undefined)
	if (valid.length === 0) return undefined
	if (valid.length === 1) return valid[0]
	return and(...valid)
}

/** The tiebreak, selected as the id the next cursor is minted from, decoded as its column decodes */
function combId(tiebreak: SQLWrapper): SQL.Aliased<unknown> {
	const value = sql`${tiebreak}`
	return (is(tiebreak, Column) ? value.mapWith(tiebreak) : value).as(COMB_ID)
}

/** Refuses a maxRowsPerShard that is no whole number from 1: the app's configuration, so a TypeError, never a 400 (Q16 of r18) */
function assertMaxRows(merged: { maxRowsPerShard?: number | undefined }): void {
	const max = merged.maxRowsPerShard
	if (max !== undefined && (!Number.isInteger(max) || max < 1))
		throw new TypeError(`merged.maxRowsPerShard ${max} is not a whole number from 1`)
}

/**
 * The rows each shard of a merged list reads by page number: from the list's first row to the
 * page's end and one more, as any shard may hold any of them; past `maxRowsPerShard` a 400
 */
function shardWindow(parsed: ListQueryInput, merged: { maxRowsPerShard?: number | undefined }): number {
	const rows = (parsed.page ?? 1) * parsed.limit + 1
	const max = merged.maxRowsPerShard ?? MAX_ROWS_PER_SHARD
	if (rows <= max) return rows
	throw new CombError({
		cause: `A merged list reads every row up to the page's end from each shard, ${rows} here, past ${max}; page by cursor instead`,
		errorKey: combErrorKeys.PAGE_TOO_DEEP,
		status: "bad_request",
	})
}

/**
 * Whether the list binds `column`'s key as read, with no row to read its bound from: every key of a
 * merged list or a list with no anchor, and an anchored list's key its anchor row doesn't supply (QL1 of r22b)
 */
const boundAsRead = ({ merged, table }: Finish, column: SQLWrapper): boolean =>
	merged !== undefined || table === undefined || !readsBack(column, table)

/** What paginate is told of the list, beside the extras its rows carry */
function factsOf(list: Finish) {
	const { keyset, merged, parsed, sort, table, tiebreak } = list
	const fieldsWhere = (keep: (column: SQLWrapper) => boolean) =>
		new Set((keyset.keys ?? []).flatMap(({ column }, i) => (keep(column) ? [sort[i]?.field as string] : [])))
	return {
		/* the sort fields bound as the driver read them, which a rounded or unheld value can't page (QL1 of r22b) */
		asRead: fieldsWhere((column) => boundAsRead(list, column)),
		/* a computed sort, or no tiebreak, leaves nothing a cursor can resume from: the list pages by number (Q6) */
		cursorable: keyset.keys !== null && tiebreak !== null,
		/* a merged list's anchor row is on one shard only, so it never pages by reference (Q1 of r17) */
		keyset: merged !== undefined ? "merged" : table === undefined ? "derived" : "table",
		/* the sort fields a reference reads back on, by the rule the cursor's read holds (27.7) */
		byReference: fieldsWhere((column) => refersBack(column, table)),
		merged: merged !== undefined,
		query: parsed,
		window: parsed.limit + 1,
	} satisfies Omit<PaginationFacts, "expects"> & { merged: boolean }
}

/**
 * The built list over `extras`: every row carries what paginate reads, and a page whose rows do not
 * is refused (Q3). Generic, so the caller's return checks `extras` as the ListExtras it hands out
 */
function withExtras<E extends object>(list: Finish, extras: E, window = list.parsed.limit + 1) {
	const facts = { ...factsOf(list), expects: Object.keys(extras) as ListExtra[], window }
	return { extras, pagination: paginationOf(list.cursor, facts) }
}

/* the id a cursor resumes from is the tiebreak itself, so no row's own id can stand in for it (Q2) */
const idOf = (tiebreak: SortKey | null): ListExtras => (tiebreak === null ? {} : { _combId: combId(tiebreak.column) })

/**
 * The storage class SQLite holds a key in, a REAL ±Infinity as `+inf` or `-inf`, which D1's JSON
 * transport reads as null (Q3 of r20)
 */
const storageOf = (column: SQLWrapper): SQL =>
	sql`case typeof(${column}) when 'real' then case ${column} when 9e999 then '+inf' when -9e999 then '-inf' else 'real' end else typeof(${column}) end`

/* whether `column`'s Postgres type is one a driver reads as a JS Date, which keeps milliseconds where it keeps microseconds */
const isTime = (column: SQLWrapper): SQL =>
	sql`pg_typeof(${column}) in ('timestamp without time zone'::regtype, 'timestamp with time zone'::regtype, 'date'::regtype)`

const floatTypes = () => sql`'double precision'::regtype, 'real'::regtype`
const fixedTypes = () => sql`'smallint'::regtype, 'integer'::regtype, 'bigint'::regtype, 'numeric'::regtype`

/**
 * Whether a key's type is a domain whose base, through domains of domains, is one of `types`: none is
 * built in (below 16384, FirstNormalObjectId), so the domains are read only for a key of another type
 */
const isDomainOver = (column: SQLWrapper, types: SQL): SQL =>
	sql`(pg_typeof(${column})::oid >= 16384 and pg_typeof(${column})::oid = any(array(with recursive d(oid, base) as (select oid, typbasetype from pg_type where typtype = 'd' union all select d.oid, p.typbasetype from d join pg_type p on p.oid = d.base where p.typtype = 'd') select d.oid from d where d.base::regtype in (${types}))))`

/**
 * Postgres's family of a key: `float` for a double precision or real, a double the driver reads
 * exactly; `fixed` for an integer or numeric, which a driver reading it as a number past 2^53
 * rounds; `other` for any other type (Q2 of r21). A domain is its base's family, followed through
 * domains of domains (Q1 of r22; a domain over an integer or numeric is `fixed`, AB1 of area B).
 * `time` for a timestamp, timestamptz or date, whose stored value a list bound as read carries as
 * text (QL2 of r22b)
 */
const familyOf = (column: SQLWrapper): SQL =>
	sql`case when pg_typeof(${column}) in (${floatTypes()}) then 'float' when pg_typeof(${column}) in (${fixedTypes()}) then 'fixed' when ${isTime(column)} then 'time' when ${isDomainOver(column, floatTypes())} then 'float' when ${isDomainOver(column, fixedTypes())} then 'fixed' else 'other' end`

/**
 * A key's stored time as text, where a Date can't hold it (QL2 of r22b), or null for a key that is no
 * time: Postgres's own text of a timestamp, timestamptz or date, which it reads back as that type
 * (a column in string mode reads as that text already); SQLite's REAL seconds of a seconds-mode
 * timestamp at 17 significant digits, which a double reads back exactly (its integer seconds are
 * exact in a Date)
 */
function storedTextOf(dialect: ListDialect, column: SQLWrapper, asRead: boolean): SQL | null {
	if (readsRounded(column)) return sql`coalesce((${column})::text, '')`
	if (dialect === "sqlite")
		return asRead && inSeconds(column)
			? sql`case when typeof(${column}) = 'real' then printf('%!.17g', ${column}) else '' end`
			: null
	if (column instanceof DateKey) return null
	if (is(column, Column))
		return asRead && column.dataType === "object date" ? sql`coalesce((${column})::text, '')` : null
	const carried = asRead ? sql`${isTime(column)} or ${roundsOnRead(column)}` : roundsOnRead(column)
	return sql`coalesce(case when ${carried} then (${column})::text end, '')`
}

/**
 * Whether a Postgres expression's type is a number no driver reads exactly: a numeric or a domain over
 * one (QL3 of r22b). No other type carries its text, so none holds the comma keyTextsSQL joins on (AB1
 * of area B): a numeric's is digits, a sign, a point, NaN or Infinity; a time's is ISO in every DateStyle
 */
const roundsOnRead = (column: SQLWrapper): SQL =>
	sql`(pg_typeof(${column}) = 'numeric'::regtype or ${isDomainOver(column, sql`'numeric'::regtype`)})`

/** Each of `keys`' stored text, comma-joined, empty for one no list carries; asRead keys carry their time too */
function keyTextsSQL(
	keys: readonly SortKey[],
	dialect: ListDialect,
	asRead: (column: SQLWrapper) => boolean = () => false,
): SQL<string> {
	const each = keys.map(({ column }) => storedTextOf(dialect, column, asRead(column)) ?? sql`''`)
	return sql<string>`${sql.join(each, sql` || ',' || `)}`
}

/**
 * The extra that carries each sort key's stored time, comma-joined, empty for a key the list reads
 * from its anchor row or that is no time; none where no key is one. A merged list carries none: it
 * compares its rows' keys across shards, a seconds key's Date and its carried seconds in one order
 */
function keyTextsOf(list: Finish, keys: readonly SortKey[]): ListExtras {
	if (list.merged !== undefined) return {}
	const asRead = (column: SQLWrapper) => boundAsRead(list, column)
	if (keys.every(({ column }) => storedTextOf(list.dialect, column, asRead(column)) === null)) return {}
	return { _combKeyTexts: keyTextsSQL(keys, list.dialect, asRead).as("_combKeyTexts") }
}

/** The extra that carries `classes`, one a sort key and the tiebreak's last, comma-joined */
const keyTypes = (classes: SQL[]): ListExtras => ({
	_combKeyTypes: sql<string>`${sql.join(classes, sql` || ',' || `)}`.as("_combKeyTypes"),
})

/**
 * The class of each sort key and of the tiebreak, which paginate and paginateMerged read each key
 * by. A list that binds a key as read (a derived list with no anchor, a merged list, and an anchored
 * list sorted by a key its anchor row doesn't supply, QL1 of r22b) needs it for every key: a SQLite REAL, and a Postgres double precision, past 2^53 is exact where an integer
 * read as a double is rounded (Q1 of r20, Q2 of r21), the merge compares an integer libsql's intMode
 * "string" reads as a decimal string as that integer (Q2 of r20), and D1 reads a REAL ±Infinity as
 * null (Q3 of r20). A list that reads every key back from the anchor row needs it, on SQLite,
 * only for a key that is no declared column (Q2 of r19), and on Postgres, which types the cursor's
 * value by its operand, never. Beside it, each time key's stored value (keyTextsOf).
 */
function keyTypesOf(list: Finish): ListExtras {
	const { dialect, keyset, tiebreak } = list
	const keys = keyset.keys
	if (keys === null || tiebreak === null) return {}
	const asRead = keys.some(({ column }) => boundAsRead(list, column))
	if (dialect === "postgres")
		return asRead
			? {
					...keyTypes([...keys.map(({ column }) => familyOf(column)), familyOf(tiebreak.column)]),
					...keyTextsOf(list, keys),
				}
			: keyTextsOf(list, keys)
	const declared = keys.every(({ column }) => is(column, Column) || column instanceof DateKey)
	if (!asRead && (declared || !is(tiebreak.column, SQLiteColumn))) return keyTextsOf(list, keys)
	return {
		...keyTypes([...keys.map(({ column }) => storageOf(column)), sql`typeof(${tiebreak.column})`]),
		...keyTextsOf(list, keys),
	}
}

/** A cursor page: the rows past the cursor and one more, and the flag that says its anchor is gone */
function finishCursor(list: Finish, cursor: string): Finished {
	const { keyset, parsed, sort, table, tiebreak } = list
	if (!keyset.keys || !tiebreak) {
		throw new CombError({
			cause: NO_KEYSET_CAUSE,
			errorKey: combErrorKeys.CURSOR_PAGINATION_UNSUPPORTED,
			status: "bad_request",
		})
	}
	const merged = list.merged !== undefined
	const { dialect } = list
	const after = cursorWhere({ cursor, dialect, keys: keyset.keys, merged, options: list.cursor, sort, table, tiebreak })
	const gone = after.gone === undefined ? {} : { _combAnchorGone: sql<number>`${after.gone}`.as("_combAnchorGone") }
	return {
		...withExtras(list, { ...idOf(tiebreak), ...keyTypesOf(list), ...gone }),
		limit: parsed.limit + 1,
		meta: { limit: parsed.limit, page: 1, type: "cursor" },
		offset: 0,
		orderBy: keyset.orderBy,
		search: parsed.q?.trim() || null,
		where: combineWhere(...list.where, after.where),
	}
}

/** A page by number, counted; a merged list's shards each read every row before its end */
function finishOffset(list: Finish): Finished {
	const { keyset, merged, parsed, tiebreak } = list
	assertPageWithin(parsed)
	const page = parsed.page ?? 1
	const total = { _total: sql<number>`cast(count(*) over() as integer)`.as("_total") }
	/* each shard reads the merged page's every row before it, and counts its part, which paginateMerged sums */
	const window = merged === undefined ? parsed.limit + 1 : shardWindow(parsed, merged)
	return {
		...withExtras(list, { ...idOf(tiebreak), ...keyTypesOf(list), ...total }, window),
		limit: window,
		meta: { limit: parsed.limit, page, type: "offset" },
		offset: merged === undefined ? (page - 1) * parsed.limit : 0,
		orderBy: keyset.orderBy,
		search: parsed.q?.trim() || null,
		where: combineWhere(...list.where),
	}
}

/**
 * Shared tail of both builders: cursor predicate, pagination mode, result shape.
 * `keys` null means the order includes something keyset cannot express.
 */
function finish(given: Finish): Finished {
	assertCursorWired(given.cursor)
	assertLimitWithin(given.parsed)
	if (given.merged !== undefined) assertMaxRows(given.merged)
	/* paginateMerged compares as SQLite does (r22 Q2); a Postgres server's numeric and collated text orders are its own */
	if (given.merged !== undefined && given.dialect === "postgres")
		throw new TypeError(
			"a merged list is merged in memory as SQLite orders, but Postgres orders numeric text and collated text on the server, which no in-memory merge can know: merge a SQLite list, or page this one on its server",
		)
	return given.parsed.cursor ? finishCursor(given, given.parsed.cursor) : finishOffset(given)
}

export { finish, type Keyset, keyTextsSQL }
