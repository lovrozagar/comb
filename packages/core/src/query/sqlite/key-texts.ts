/**
 * The SQL a list selects beside each row so paginate reads its sort keys as stored: each key's
 * storage class or type family (`_combKeyTypes`), its stored text where the driver's read rounds it
 * (`_combKeyTexts`), and a SQLite key's value its mode reads as another (`_combTextKeys`). list-finish.ts picks which a list
 * selects; listOptions selects the texts on every sorted page.
 */
import { Column, is, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import type { ListDialect } from "../list-dialect.ts"
import { carriesOpaque, DateKey, readsRounded } from "./cursor-fit.ts"
import type { SortKey } from "./keyset.ts"
import { heldApart, holdsText, storedReads } from "./timestamp-column.ts"

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
 * in every DateStyle, which it reads back as that type in any session, on every list: a cursor binds it
 * once the row a list reads the key back from is gone, and a read in string mode follows DateStyle,
 * whose zone abbreviation reads back as another zone (AB3-4 of area B); a SQLite timestamp's stored seconds or
 * milliseconds as the text of them SQLite reads back as them (readBackText), where a Date keeps whole
 * milliseconds (AB3-1 of area B), or `!n` and its printf text where no text does (AB4-7 of area B); a Postgres custom column a numeric's text alone, its time bound by its mapper (AB2).
 * A SQLite key holding a value of a class its mode does not read back as stored (readsAsStored), a
 * timestamp's TEXT or ±Infinity among them, carries `!` and that class, comma-free, on a list that
 * binds it as read, which no list binds a cursor from; one that reads it back carries the value itself
 * apart, never joined (textKeysSQL; B2-3, AB3-2, AB4-2 of area B)
 */
function storedTextOf(dialect: ListDialect, column: SQLWrapper, asRead: boolean): SQL | null {
	if (readsRounded(column)) return sql`coalesce((${column})::text, '')`
	if (dialect === "sqlite") {
		if (!asRead) return null
		const reads = readsAsStored(column)
		if (reads === undefined) return null
		const time = holdsText(column)
			? sql`when typeof(${column}) in ('integer', 'real') and abs(${column}) < 9e999 then ${readBackText(column, (text) => text)} `
			: sql``
		return sql`case ${time}when ${reads} then '' else '!' || typeof(${column}) end`
	}
	if (column instanceof DateKey) return null
	if (is(column, Column) && !carriesOpaque(column)) {
		if (FLOATS.has(column.dataType)) return sql`case when ${unprinted(column)} then '!f' else '' end`
		return DATESTYLED.has(column.dataType) ? sql`coalesce(${isoText(column)}, '')` : null
	}
	const time = carriesOpaque(column) ? sql`` : sql` when ${isTime(column)} then ${isoText(column)}`
	const float = sql` when ${isFloat(column)} and ${unprinted(column)} then '!f'`
	return sql`coalesce(case when ${roundsOnRead(column)} then (${column})::text${float}${time} end, '')`
}

// lookup-table: drizzle's Postgres float columns, which a driver reads from the text extra_float_digits prints (AB4-4 of area B)
const FLOATS = /* @__PURE__ */ new Set(["number double", "number float"])

/* whether a Postgres expression's type is a double precision or real, or a domain over one */
const isFloat = (column: SQLWrapper): SQL =>
	sql`(pg_typeof(${column}) in (${floatTypes()}) or ${isDomainOver(column, floatTypes())})`

/**
 * Whether a Postgres float key's value reaches the driver rounded: every text Postgres prints a float
 * in follows extra_float_digits, which at 0 or below keeps 15 significant digits (6 for a real), so
 * 1.0000000000000002 reads as 1 and its cursor skips the rows that hold 1 (AB4-4 of area B). The row
 * carries `!f`, which paginate refuses on the page that serves it, as it does a SQLite TEXT's `!`
 */
const unprinted = (column: SQLWrapper): SQL =>
	sql`(${column} is not null and current_setting('extra_float_digits')::int <= 0)`

/**
 * A SQLite number's text that SQLite reads back as it, in the same query, as `held` wraps it, else
 * `!n` and the printf text (AB4-7 of area B): `cast(k as text)`, which libsql and D1 write at 15
 * significant digits, else `printf('%!.17g', k)`, which D1 misprints past about 1e100 and below
 * 1e-100. A cursor binds the text as `cast(? as real)`, the parse the check made, so no near text
 * stands in for the value; a merge orders an unheld one by its printed text, and the page that serves it refuses
 */
function readBackText(column: SQLWrapper, held: (text: SQL) => SQL): SQL {
	const cast = sql`cast(${column} as text)`
	const printed = sql`printf('%!.17g', ${column})`
	return sql`case when cast(${cast} as real) = ${column} then ${held(cast)} when cast(${printed} as real) = ${column} then ${held(printed)} else '!n' || ${printed} end`
}

type StoredClass = "blob" | "integer" | "real" | "text"

/* a storage class but NULL as SQLite's typeof() names it, a literal, so no set spends a bound parameter */
function className(stored: StoredClass): SQL {
	switch (stored) {
		case "blob":
			return sql`'blob'`
		case "integer":
			return sql`'integer'`
		case "real":
			return sql`'real'`
		default:
			return sql`'text'`
	}
}

/* the classes of a StoredReads set, as typeof() names them (AB4-2 of area B) */
const classList = (classes: readonly StoredClass[]): SQL => sql.join(classes.map(className), sql`, `)

/**
 * Whether a SQLite key's row holds what its mode reads back as stored (storedReads): NULL, or a value
 * of a class its set names, a REAL of `finite` short of ±Infinity; a boolean's a number that is 0 or 1
 * (AB3-2 of area B). Undefined for a column with no set (AB4-2 of area B)
 */
function readsAsStored(column: SQLWrapper): SQL | undefined {
	const reads = storedReads(column)
	if (reads === undefined) return undefined
	if (reads === "boolean")
		return sql`(${column} is null or (typeof(${column}) in ('integer', 'real') and ${column} in (0, 1)))`
	const classes = reads.filter((each): each is StoredClass => each !== "finite")
	const finite = reads.includes("finite") ? sql` or (typeof(${column}) = 'real' and abs(${column}) < 9e999)` : sql``
	return sql`(typeof(${column}) in ('null', ${classList(classes)})${finite})`
}

/**
 * A SQLite key's stored value, where its mode reads another (readsAsStored), as its storage class and
 * its text: an integer's digits, a REAL as the text of it SQLite reads back as it (readBackText), or
 * `!n` and its printf text where none does (AB4-7 of area B), ±Infinity as the 9e999 SQLite reads as it, a TEXT itself and
 * a blob's hex; null where the mode reads it back (AB3-2, AB4-2 of area B)
 */
const heldStored = (column: SQLWrapper, reads: SQL): SQL =>
	sql`case when ${reads} then null when typeof(${column}) = 'integer' then json_array('integer', cast(${column} as text)) when typeof(${column}) = 'real' then case when abs(${column}) < 9e999 then ${readBackText(column, (text) => sql`json_array('real', ${text})`)} else json_array('real', case when ${column} > 0 then '9e999' else '-9e999' end) end when typeof(${column}) = 'text' then json_array('text', ${column}) else json_array('blob', hex(${column})) end`

// lookup-table: the Postgres columns whose read follows DateStyle, or keeps milliseconds of a time's microseconds (AB3-4 of area B)
const DATESTYLED = /* @__PURE__ */ new Set(["object date", "string date", "string timestamp"])

/* B2-7 of area B: a time's ::text follows DateStyle, whose zone abbreviation (IST, PST) reads back as another zone */
const isoText = (column: SQLWrapper): SQL => sql`(to_json(${column}) #>> '{}')`

/**
 * Whether a Postgres expression's type is a number no driver reads exactly: a numeric or a domain over
 * one (QL3 of r22b). No other type carries its text, so none holds the comma keyTextsSQL joins on (AB1
 * of area B): a numeric's is digits, a sign, a point, NaN or Infinity; a time's is to_json's ISO 8601
 */
const roundsOnRead = (column: SQLWrapper): SQL =>
	sql`(pg_typeof(${column}) = 'numeric'::regtype or ${isDomainOver(column, sql`'numeric'::regtype`)})`

/** Each of `keys`' stored text, comma-joined, empty for one no list carries; asRead SQLite keys carry their time too */
function keyTextsSQL(
	keys: readonly SortKey[],
	dialect: ListDialect,
	asRead: (column: SQLWrapper) => boolean = () => false,
): SQL<string> {
	const each = keys.map(({ column }) => storedTextOf(dialect, column, asRead(column)) ?? sql`''`)
	return sql<string>`${sql.join(each, sql` || ',' || `)}`
}

/**
 * The stored value each key `held` names carries apart, a JSON array with null for every other key,
 * so a cursor binds the row's own value, exact with the row gone (a reference past the cap): a SQLite
 * key's value of a class its mode does not read back as stored, as its class and text (heldStored),
 * such as a timestamp's TEXT, which SQLite orders after every number and no Date's milliseconds place
 * (B2-3 of area B), or a boolean's value but 0 or 1 (AB3-2). It is never comma-joined, as a TEXT may
 * hold a comma. Empty where no key is held, which a Postgres table's
 * never is, and no Postgres before 16 has json_array
 */
function textKeysSQL(keys: readonly SortKey[], held: (column: SQLWrapper) => boolean = heldApart): SQL<string> {
	if (!keys.some(({ column }) => held(column))) return sql<string>`''`
	const each = keys.map(({ column }) => {
		const reads = held(column) ? readsAsStored(column) : undefined
		return reads === undefined ? sql`null` : heldStored(column, reads)
	})
	return sql<string>`json_array(${sql.join(each, sql`, `)})`
}

export { familyOf, keyTextsSQL, storageOf, storedTextOf, textKeysSQL }
