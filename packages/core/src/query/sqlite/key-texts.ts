/**
 * The SQL a list selects beside each row so paginate reads its sort keys as stored: each key's
 * storage class or type family (`_combKeyTypes`), its stored text where the driver's read rounds it
 * (`_combKeyTexts`), and a SQLite timestamp's TEXT (`_combTextKeys`). list-finish.ts picks which a list
 * selects; listOptions selects the texts on every sorted page.
 */
import { Column, is, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import type { ListDialect } from "../list-dialect.ts"
import { carriesOpaque, DateKey, readsRounded } from "./cursor-fit.ts"
import type { SortKey } from "./keyset.ts"
import { holdsText } from "./timestamp-column.ts"

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
 * time: a Postgres timestamp, timestamptz or date as to_json writes it, ISO 8601 with a numeric offset
 * in every DateStyle, which it reads back as that type in any session (a column in string mode reads
 * as its text already); a SQLite timestamp's stored seconds or
 * milliseconds at 17 significant digits, which a double reads back exactly, where a Date keeps whole
 * milliseconds; a Postgres custom column a numeric's text alone, its time bound by its mapper (AB2).
 * A SQLite timestamp holding TEXT, which drizzle reads as a Date and SQLite orders after every number,
 * carries `!`, comma-free, on a list that binds it as read, which no list binds a cursor from; one
 * that reads it back carries the text itself apart, never joined (textKeysOf, B2-3 of area B)
 */
function storedTextOf(dialect: ListDialect, column: SQLWrapper, asRead: boolean): SQL | null {
	if (readsRounded(column)) return sql`coalesce((${column})::text, '')`
	if (dialect === "sqlite") {
		if (!asRead) return null
		return holdsText(column)
			? sql`case when typeof(${column}) in ('integer', 'real') then printf('%!.17g', ${column}) when typeof(${column}) = 'text' then '!' else '' end`
			: null
	}
	if (column instanceof DateKey) return null
	if (is(column, Column) && !carriesOpaque(column))
		return asRead && column.dataType === "object date" ? sql`coalesce(${isoText(column)}, '')` : null
	const time = asRead && !carriesOpaque(column) ? sql` when ${isTime(column)} then ${isoText(column)}` : sql``
	return sql`coalesce(case when ${roundsOnRead(column)} then (${column})::text${time} end, '')`
}

/* B2-7 of area B: a time's ::text follows DateStyle, whose zone abbreviation (IST, PST) reads back as another zone */
const isoText = (column: SQLWrapper): SQL => sql`(to_json(${column}) #>> '{}')`

/**
 * Whether a Postgres expression's type is a number no driver reads exactly: a numeric or a domain over
 * one (QL3 of r22b). No other type carries its text, so none holds the comma keyTextsSQL joins on (AB1
 * of area B): a numeric's is digits, a sign, a point, NaN or Infinity; a time's is to_json's ISO 8601
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
 * The TEXT each SQLite timestamp key `held` names holds, a JSON array with null for every other key,
 * so a cursor binds a TEXT row's own text, exact with the row gone (a reference past the cap): SQLite
 * orders every TEXT after every number, which no Date's milliseconds place. It is never comma-joined,
 * as a TEXT may hold a comma (B2-3 of area B). Empty where no key is held, which a Postgres table's
 * never is, and no Postgres before 16 has json_array
 */
function textKeysSQL(keys: readonly SortKey[], held: (column: SQLWrapper) => boolean = holdsText): SQL<string> {
	if (!keys.some(({ column }) => held(column))) return sql<string>`''`
	const each = keys.map(({ column }) =>
		held(column) ? sql`case when typeof(${column}) = 'text' then ${column} end` : sql`null`,
	)
	return sql<string>`json_array(${sql.join(each, sql`, `)})`
}

export { familyOf, keyTextsSQL, storageOf, storedTextOf, textKeysSQL }
