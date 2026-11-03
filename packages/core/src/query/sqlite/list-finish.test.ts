/**
 * The shared tail of the SQLite list builders: the page window, merged or not, and the cursor
 * pagination a list with no keyset refuses. The builders' own behavior is build-list-query.test.ts's.
 */
import { type SQL, sql } from "drizzle-orm"
import { PgDialect, pgTable, text as pgText, timestamp } from "drizzle-orm/pg-core"
import { integer, SQLiteDialect, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { SEALED } from "../__fixtures__/cursor-secret.ts"
import { createCursor } from "../cursor-mint.ts"
import { DateKey } from "./cursor-fit.ts"
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
		expect(times["_combKeyTexts"]).toBe(
			`coalesce(("pg_ev"."at")::text, '') || ',' || coalesce(case when pg_typeof("pg_ev"."at") in ('timestamp without time zone'::regtype, 'timestamp with time zone'::regtype, 'date'::regtype) then ("pg_ev"."at")::text end, '') || ',' || '' || ',' || ''`,
		)
		expect(extrasOf("postgres", [{ column: pgEv.label, direction: "asc" }])).not.toHaveProperty("_combKeyTexts")
		expect(extrasOf("postgres", [{ column: pgEv.at, direction: "asc" }], { table: pgEv as never })).toEqual({
			_combId: expect.any(String),
			_total: expect.any(String),
		})
	})
})
