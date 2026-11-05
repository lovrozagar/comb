/**
 * The shared tail of the SQLite list builders: the page window, merged or not, and the cursor
 * pagination a list with no keyset refuses. The builders' own behavior is build-list-query.test.ts's.
 */
import { type SQL, sql } from "drizzle-orm"
import { numeric as pgNumeric, PgDialect, pgTable, text as pgText, timestamp } from "drizzle-orm/pg-core"
import { integer, SQLiteDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../__fixtures__/cursor-secret.ts"
import { createCursor } from "../cursor-mint.ts"
import { DateKey } from "./cursor-fit.ts"
import { keyTextsSQL, textKeysSQL } from "./key-texts.ts"
import { finish } from "./list-finish.ts"

const t = sqliteTable("t", { id: integer("id").primaryKey() })
const tiebreak = { column: t.id, direction: "desc" as const }

/** finish over `t`, its order the tiebreak alone, with `over` in place of any default */
const finished = (over: Partial<Parameters<typeof finish>[0]> = {}) =>
	finish({
		cursor: SEALED,
		dialect: "sqlite",
		keyset: { keys: [], orderBy: [sql`1`] },
		parsed: { limit: 2, parsedSort: [] },
		sort: [],
		table: t,
		tiebreak,
		where: [],
		...over,
	})

describe("finish", () => {
	it("reads one past the page from its offset, or every row to the page's end from each shard of a merged list", () => {
		expect(finished({ parsed: { limit: 2, page: 3, parsedSort: [] } })).toMatchObject({ limit: 3, offset: 4 })
		expect(finished({ merged: {}, parsed: { limit: 2, page: 3, parsedSort: [] } })).toMatchObject({
			limit: 7,
			offset: 0,
		})
		expect(() => finished({ merged: { maxRowsPerShard: 6 }, parsed: { limit: 2, page: 3, parsedSort: [] } })).toThrow(
			expect.objectContaining({ errorKey: "page_too_deep", status: 400 }),
		)
	})

	it("refuses a cursor on a list no keyset can resume, and selects no tiebreak there", () => {
		const cursor = createCursor({ id: 1 }, [], SEALED)
		expect(() =>
			finished({ keyset: { keys: null, orderBy: [] }, parsed: { cursor, limit: 2, parsedSort: [] } }),
		).toThrow(expect.objectContaining({ errorKey: "cursor_pagination_unsupported", status: 400 }))
		expect(Object.keys(finished({ tiebreak: null }).extras)).toEqual(["_total"])
	})
})

/* QL1 and QL2 of r22b: the classes and stored times of the keys a list binds as read */
const ev = sqliteTable("ev", {
	at: integer("at", { mode: "timestamp" }),
	id: integer("id").primaryKey(),
	j: text("j", { mode: "json" }),
	n: integer("n"),
})
const side = sqliteTable("side", { at: integer("at", { mode: "timestamp" }) })
const evMs = sqliteTable("ev_ms", { at: integer("at", { mode: "timestamp_ms" }), id: integer("id").primaryKey() })
const pgEv = pgTable("pg_ev", {
	at: timestamp("at", { precision: 6 }),
	id: pgText("id").primaryKey(),
	label: pgText("label"),
})
const sort = (n: number) => Array.from({ length: n }, (_, i) => ({ direction: "asc" as const, field: `k${i}` }))

/** The extras of a list keyed by `keys`, each rendered to SQL text on its dialect */
function extrasOf(
	dialect: "postgres" | "sqlite",
	keys: Parameters<typeof finish>[0]["keyset"]["keys"] & object,
	over: Partial<Parameters<typeof finish>[0]> = {},
): Record<string, string> {
	const render = dialect === "postgres" ? new PgDialect() : new SQLiteDialect()
	const id = dialect === "postgres" ? pgEv.id : ev.id
	const built = finish({
		cursor: SEALED,
		dialect,
		keyset: { keys, orderBy: [sql`1`] },
		parsed: { limit: 2, parsedSort: sort(keys.length) },
		sort: sort(keys.length),
		tiebreak: { column: id, direction: "asc" },
		where: [],
		...over,
	})
	return Object.fromEntries(
		Object.entries(built.extras as Record<string, { sql: SQL }>).map(([name, extra]) => [
			name,
			render.sqlToQuery(extra.sql).sql,
		]),
	)
}

describe("finish's stored times on SQLite (QL2 of r22b; sibling: _combKeyTypes)", () => {
	/* AB3 of area B: a merged list carries them too, an INTEGER's as well, so its merge compares every row in seconds */
	it("carries a SQLite seconds key's stored seconds on a list that binds it as read, merged or not, another's mark alone", () => {
		const SECONDS = `case when typeof("ev"."at") in ('integer', 'real') and abs("ev"."at") < 9e999 then printf('%!.17g', "ev"."at") when (typeof("ev"."at") in ('null', 'integer', 'real')) then '' else '!' || typeof("ev"."at") end`
		const MARK = `case when (typeof("ev"."n") in ('null', 'integer', 'real')) then '' else '!' || typeof("ev"."n") end`
		const anchorless = extrasOf("sqlite", [
			{ column: ev.at, direction: "asc" },
			{ column: ev.n, direction: "asc" },
			{ column: ev.j, direction: "asc" },
		])
		expect(anchorless["_combKeyTexts"]).toBe(`${SECONDS} || ',' || ${MARK} || ',' || ''`)
		expect(extrasOf("sqlite", [{ column: ev.at, direction: "asc" }], { merged: {} })["_combKeyTexts"]).toBe(SECONDS)
		expect(extrasOf("sqlite", [{ column: ev.n, direction: "asc" }], { merged: {} })["_combKeyTexts"]).toBe(MARK)
		/* AB4-2 of area B: a JSON key has no set of classes, so nothing marks it */
		expect(extrasOf("sqlite", [{ column: ev.j, direction: "asc" }], { merged: {} })).not.toHaveProperty("_combKeyTexts")
	})

	it("selects classes and times on an anchored list only for a key its anchor row doesn't supply", () => {
		expect(extrasOf("sqlite", [{ column: ev.at, direction: "asc" }], { table: ev })).not.toHaveProperty("_combKeyTypes")
		const joined = extrasOf(
			"sqlite",
			[
				{ column: ev.at, direction: "asc" },
				{ column: side.at, direction: "asc" },
			],
			{
				table: ev,
			},
		)
		expect(joined["_combKeyTypes"]).toContain("typeof")
		expect(joined["_combKeyTexts"]).toMatch(/^'' \|\| ',' \|\| case when typeof\("side"\."at"\)/)
	})
})

/** textKeysSQL of `keys`, every one held, rendered on SQLite */
const held = (keys: Parameters<typeof textKeysSQL>[0]) => new SQLiteDialect().sqlToQuery(textKeysSQL(keys)).sql

describe("finish's SQLite timestamp keys holding TEXT (B2-3 of area B)", () => {
	it("carries a read-back key's stored value apart, a JSON array never comma-joined, and on an as-read list only its mark", () => {
		const table = extrasOf(
			"sqlite",
			[
				{ column: ev.at, direction: "asc" },
				{ column: ev.n, direction: "asc" },
			],
			{ table: ev },
		)
		expect(table["_combTextKeys"]).toBe(
			held([
				{ column: ev.at, direction: "asc" },
				{ column: ev.n, direction: "asc" },
			]),
		)
		expect(table["_combTextKeys"]).toMatch(
			/^json_array\(case when .* then json_array\('text', "ev"."at"\) .*, case when /,
		)
		expect(table).not.toHaveProperty("_combKeyTexts")
		const ms = extrasOf("sqlite", [{ column: evMs.at, direction: "asc" }], { table: evMs })
		expect(ms["_combTextKeys"]).toBe(held([{ column: evMs.at, direction: "asc" }]))
		/* bound as read: no text, only the mark a 500 names it by, beside a number's stored milliseconds (B2-6 of area B) */
		const anchorless = extrasOf("sqlite", [{ column: evMs.at, direction: "asc" }])
		expect(anchorless).not.toHaveProperty("_combTextKeys")
		expect(anchorless["_combKeyTexts"]).toBe(
			`case when typeof("ev_ms"."at") in ('integer', 'real') and abs("ev_ms"."at") < 9e999 then printf('%!.17g', "ev_ms"."at") when (typeof("ev_ms"."at") in ('null', 'integer', 'real')) then '' else '!' || typeof("ev_ms"."at") end`,
		)
		expect(extrasOf("sqlite", [{ column: ev.at, direction: "asc" }], { merged: {} })).not.toHaveProperty(
			"_combTextKeys",
		)
		expect(extrasOf("sqlite", [{ column: ev.j, direction: "asc" }], { table: ev })).not.toHaveProperty("_combTextKeys")
		expect(extrasOf("postgres", [{ column: pgEv.at, direction: "asc" }], { table: pgEv })).not.toHaveProperty(
			"_combTextKeys",
		)
		/* a Postgres derived list, anchored or not, selects none either */
		expect(extrasOf("postgres", [{ column: pgEv.at, direction: "asc" }])).not.toHaveProperty("_combTextKeys")
		expect(extrasOf("postgres", [{ column: sql`${pgEv.at}`, direction: "asc" }], { table: pgEv })).not.toHaveProperty(
			"_combTextKeys",
		)
	})
})

describe("finish's key families and stored times on Postgres (QL1, QL2 of r22b; sibling: SQLite's)", () => {
	it("carries a Postgres date column's text, an expression's where its type is a time, and nothing for any other key", () => {
		const times = extrasOf("postgres", [
			{ column: pgEv.at, direction: "asc" },
			{ column: sql`${pgEv.at}`, direction: "asc" },
			{ column: pgEv.label, direction: "asc" },
			{ column: new DateKey(sql`1`), direction: "asc" },
		])
		expect(times["_combKeyTypes"]).toContain("then 'time'")
		/* beside a time, only a numeric or a domain over one is carried (AB1 of area B); a float, or a domain over one,
		   is marked where the session prints it rounded (AB4-4 of area B) */
		const OVER_NUMERIC = `(pg_typeof("pg_ev"."at")::oid >= 16384 and pg_typeof("pg_ev"."at")::oid = any(array(with recursive d(oid, base) as (select oid, typbasetype from pg_type where typtype = 'd' union all select d.oid, p.typbasetype from d join pg_type p on p.oid = d.base where p.typtype = 'd') select d.oid from d where d.base::regtype in ('numeric'::regtype))))`
		const OVER_FLOAT = `(pg_typeof("pg_ev"."at") in ('double precision'::regtype, 'real'::regtype) or (pg_typeof("pg_ev"."at")::oid >= 16384 and pg_typeof("pg_ev"."at")::oid = any(array(with recursive d(oid, base) as (select oid, typbasetype from pg_type where typtype = 'd' union all select d.oid, p.typbasetype from d join pg_type p on p.oid = d.base where p.typtype = 'd') select d.oid from d where d.base::regtype in ('double precision'::regtype, 'real'::regtype)))))`
		expect(times["_combKeyTexts"]).toBe(
			`coalesce((to_json("pg_ev"."at") #>> '{}'), '') || ',' || coalesce(case when (pg_typeof("pg_ev"."at") = 'numeric'::regtype or ${OVER_NUMERIC}) then ("pg_ev"."at")::text when ${OVER_FLOAT} and ("pg_ev"."at" is not null and current_setting('extra_float_digits')::int <= 0) then '!f' when pg_typeof("pg_ev"."at") in ('timestamp without time zone'::regtype, 'timestamp with time zone'::regtype, 'date'::regtype) then (to_json("pg_ev"."at") #>> '{}') end, '') || ',' || '' || ',' || ''`,
		)
		expect(extrasOf("postgres", [{ column: pgEv.label, direction: "asc" }])).not.toHaveProperty("_combKeyTexts")
		/* AB3-4 of area B: a list that reads the key back carries it too, for a cursor whose row is gone */
		expect(extrasOf("postgres", [{ column: pgEv.at, direction: "asc" }], { table: pgEv as never })).toEqual({
			_combId: expect.any(String),
			_combKeyTexts: `coalesce((to_json("pg_ev"."at") #>> '{}'), '')`,
			_total: expect.any(String),
		})
	})
})

/* QL3 of r22b: a number key whose read rounds it carries its text on every list, a row to read back or none */
describe("finish's carried numeric texts (QL3 of r22b; sibling: the stored times)", () => {
	const amount = pgTable("amount", { id: pgText("id").primaryKey(), n: pgNumeric("n", { mode: "number" }) })

	it("carries a numeric in number mode on an anchored list, a table list and the relational one, beside a time", () => {
		const anchored = extrasOf("postgres", [{ column: amount.n, direction: "asc" }], { table: amount as never })
		expect(anchored).not.toHaveProperty("_combKeyTypes")
		expect(anchored["_combKeyTexts"]).toBe(`coalesce(("amount"."n")::text, '')`)
		const table = extrasOf("sqlite", [{ column: amount.n, direction: "asc" }], { table: amount as never })
		expect(table["_combKeyTexts"]).toBe(`coalesce(("amount"."n")::text, '')`)
		const relational = keyTextsSQL(
			[
				{ column: amount.n, direction: "asc" },
				{ column: pgEv.at, direction: "asc" },
			],
			"postgres",
		)
		expect(new PgDialect().sqlToQuery(relational).sql).toBe(
			`coalesce(("amount"."n")::text, '') || ',' || coalesce((to_json("pg_ev"."at") #>> '{}'), '')`,
		)
	})

	it("carries an anchored Postgres expression's text where its type may read rounded or is a time (AB3-4 of area B)", () => {
		const own = extrasOf("postgres", [{ column: sql`${pgEv.at}`, direction: "asc" }], { table: pgEv as never })
		expect(own["_combKeyTexts"]).toMatch(/^coalesce\(case when \(pg_typeof\("pg_ev"\."at"\) = 'numeric'::regtype or /)
		expect(own["_combKeyTexts"]).toContain(`then (to_json("pg_ev"."at") #>> '{}') end`)
	})
})
