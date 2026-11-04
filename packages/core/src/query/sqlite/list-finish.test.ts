/**
 * The shared tail of the SQLite list builders: the page window, merged or not, and the cursor
 * pagination a list with no keyset refuses. The builders' own behavior is build-list-query.test.ts's.
 */
import { type SQL, sql } from "drizzle-orm"
import { customType, numeric as pgNumeric, PgDialect, pgTable, text as pgText, timestamp } from "drizzle-orm/pg-core"
import { integer, SQLiteDialect, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../__fixtures__/cursor-secret.ts"
import { createCursor } from "../cursor-mint.ts"
import { DateKey } from "./cursor-fit.ts"
import { finish, keyTextsSQL } from "./list-finish.ts"

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
	n: integer("n"),
})
const side = sqliteTable("side", { at: integer("at", { mode: "timestamp" }) })
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
	it("carries a SQLite seconds key's REAL seconds on a list that binds it as read, and none on a merged list or for another key", () => {
		const anchorless = extrasOf("sqlite", [
			{ column: ev.at, direction: "asc" },
			{ column: ev.n, direction: "asc" },
		])
		expect(anchorless["_combKeyTexts"]).toBe(
			`case when typeof("ev"."at") = 'real' then printf('%!.17g', "ev"."at") else '' end || ',' || ''`,
		)
		expect(extrasOf("sqlite", [{ column: ev.n, direction: "asc" }])["_combKeyTexts"]).toBeUndefined()
		expect(extrasOf("sqlite", [{ column: ev.at, direction: "asc" }], { merged: {} })).not.toHaveProperty(
			"_combKeyTexts",
		)
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

describe("finish's key families and stored times on Postgres (QL1, QL2 of r22b; sibling: SQLite's)", () => {
	it("carries a Postgres date column's text, an expression's where its type is a time, and nothing for any other key", () => {
		const times = extrasOf("postgres", [
			{ column: pgEv.at, direction: "asc" },
			{ column: sql`${pgEv.at}`, direction: "asc" },
			{ column: pgEv.label, direction: "asc" },
			{ column: new DateKey(sql`1`), direction: "asc" },
		])
		expect(times["_combKeyTypes"]).toContain("then 'time'")
		/* beside a time, only a numeric or a domain over one is carried (AB1 of area B) */
		const OVER_NUMERIC = `(pg_typeof("pg_ev"."at")::oid >= 16384 and pg_typeof("pg_ev"."at")::oid = any(array(with recursive d(oid, base) as (select oid, typbasetype from pg_type where typtype = 'd' union all select d.oid, p.typbasetype from d join pg_type p on p.oid = d.base where p.typtype = 'd') select d.oid from d where d.base::regtype in ('numeric'::regtype))))`
		expect(times["_combKeyTexts"]).toBe(
			`coalesce(("pg_ev"."at")::text, '') || ',' || coalesce(case when pg_typeof("pg_ev"."at") in ('timestamp without time zone'::regtype, 'timestamp with time zone'::regtype, 'date'::regtype) or (pg_typeof("pg_ev"."at") = 'numeric'::regtype or ${OVER_NUMERIC}) then ("pg_ev"."at")::text end, '') || ',' || '' || ',' || ''`,
		)
		expect(extrasOf("postgres", [{ column: pgEv.label, direction: "asc" }])).not.toHaveProperty("_combKeyTexts")
		expect(extrasOf("postgres", [{ column: pgEv.at, direction: "asc" }], { table: pgEv as never })).toEqual({
			_combId: expect.any(String),
			_total: expect.any(String),
		})
	})
})

/* QL3 of r22b: a number key whose read rounds it carries its text on every list, a row to read back or none */
describe("finish's carried numeric texts (QL3 of r22b; sibling: the stored times)", () => {
	const amount = pgTable("amount", { id: pgText("id").primaryKey(), n: pgNumeric("n", { mode: "number" }) })

	it("carries a numeric in number mode on an anchored list, a table list and the relational one, and nothing else there", () => {
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
		expect(new PgDialect().sqlToQuery(relational).sql).toBe(`coalesce(("amount"."n")::text, '') || ',' || ''`)
	})

	it("carries an anchored Postgres expression's text only where its type may read rounded, not as a time", () => {
		const own = extrasOf("postgres", [{ column: sql`${pgEv.at}`, direction: "asc" }], { table: pgEv as never })
		expect(own["_combKeyTexts"]).toMatch(/^coalesce\(case when \(pg_typeof\("pg_ev"\."at"\) = 'numeric'::regtype or /)
	})
})

/** keyTextsSQL of `column` alone on SQLite, bound as read, rendered */
const render = (column: Parameters<typeof keyTextsSQL>[0][number]["column"]) =>
	new SQLiteDialect().sqlToQuery(keyTextsSQL([{ column, direction: "asc" }], "sqlite", () => true)).sql

/*
 * AB1 of area B: keyTextsSQL joins the carried texts on a comma, so a carried text must never hold
 * one. Only a numeric's text (digits, a sign, a point, NaN, Infinity), a time's (ISO under every
 * DateStyle) and SQLite's REAL seconds are carried; any other key is read exactly and carries ''.
 */
describe("keyTextsSQL carries only numeric, time and seconds texts (AB1 of area B; sibling: QL3's carriage)", () => {
	const kinds = pgTable("kinds", {
		amount: customType<{ data: number; driverData: string }>({ dataType: () => "amount" })("amount"),
		at: timestamp("at", { mode: "string", precision: 6 }),
		id: pgText("id").primaryKey(),
		label: pgText("label"),
		n: pgNumeric("n", { mode: "number" }),
		when: timestamp("when", { precision: 6 }),
	})
	const sqliteKinds = sqliteTable("sqlite_kinds", {
		at: integer("at", { mode: "timestamp" }),
		label: integer("label"),
	})
	const pgKeys: Array<[string, Parameters<typeof keyTextsSQL>[0][number]["column"], boolean]> = [
		["a numeric in number mode", kinds.n, true],
		["a date-mode timestamp", kinds.when, true],
		["a string-mode timestamp", kinds.at, false],
		["a text column", kinds.label, false],
		["an expression", sql`${kinds.label}`, true],
		["a customType column", kinds.amount, true],
	]
	const TYPES_ALLOWED = ["numeric", "timestamp without time zone", "timestamp with time zone", "date"]

	it.each([false, true])("names no type but a numeric or a time in a Postgres key's guard (as read: %s)", (asRead) => {
		const rendered = new PgDialect().sqlToQuery(
			keyTextsSQL(
				pgKeys.map(([, column]) => ({ column, direction: "asc" as const })),
				"postgres",
				() => asRead,
			),
		).sql
		const named = [...rendered.matchAll(/'([^']+)'::regtype/g)].map((match) => match[1])
		expect(named.length).toBeGreaterThan(0)
		expect(named.filter((type) => !TYPES_ALLOWED.includes(type as string))).toEqual([])
	})

	it.each(pgKeys)("carries %s's text or nothing, by its type", (_, column, carries) => {
		const rendered = new PgDialect().sqlToQuery(keyTextsSQL([{ column, direction: "asc" }], "postgres", () => true)).sql
		expect(rendered === "''").toBe(!carries)
	})

	/* AB2 of area B: its mapper may read a numeric as a number; a time binds through that mapper, so it carries none */
	it("carries a Postgres customType column's text where it is a numeric alone, bound as read or not", () => {
		for (const asRead of [false, true]) {
			const rendered = new PgDialect().sqlToQuery(
				keyTextsSQL([{ column: kinds.amount, direction: "asc" }], "postgres", () => asRead),
			).sql
			expect(rendered).toMatch(/^coalesce\(case when \(pg_typeof\("kinds"\."amount"\) = 'numeric'::regtype or /)
			expect(rendered).not.toContain("timestamp")
		}
	})

	it("carries SQLite's REAL seconds of a seconds-mode timestamp alone, as a number's digits", () => {
		expect(render(sqliteKinds.at)).toContain("printf('%!.17g', ")
		expect(render(sqliteKinds.label)).toBe("''")
		expect(render(sql`${sqliteKinds.label}`)).toBe("''")
	})
})
