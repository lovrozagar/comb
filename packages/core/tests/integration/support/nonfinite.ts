/**
 * A SQLite REAL list over ±Infinity and NULL, paged one row at a time on any SQLite engine (R4, U4).
 * D1 hands ±Infinity over as null, so a cursor minted there carries null, and the keyset reads the
 * value back from the row. The scenarios here page every order through both builders, and edit a
 * NULL-keyed anchor between pages: deleted, or set to 5, the list resumes from where the NULL stood.
 * No test framework is imported, so vitest and bun:test share it.
 */
import { defineRelations } from "drizzle-orm"
import { integer, real, sqliteTable } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import type { CursorOptions } from "../../../src/query/cursor-seal.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { built } from "../../../src/query/__fixtures__/built.ts"

export const point = sqliteTable("point", { id: integer("id").primaryKey(), x: real("x") })
export const pointRelations = defineRelations({ point })
const schema = createListQuerySchema({ sort: ["x"], pagination: { defaultLimit: 1, maxLimit: 1 } })

export const ORDERS = ["x.asc", "x.desc", "x.asc.nullsfirst", "x.desc.nullslast"]

/** ±Infinity twice each, finite values, and three NULLs, so a NULL anchor has NULLs on both sides */
export const SEED = [
	"CREATE TABLE point (id INTEGER PRIMARY KEY, x REAL)",
	"INSERT INTO point VALUES (1, 9e999), (2, -9e999), (3, 1.5), (4, NULL), (5, -2), (6, 9e999), (7, -9e999), (8, NULL), (9, NULL)",
]
const NULL_IDS = new Set([4, 8, 9])
/* the rows D1 reads as null too: its JSON transport has no ±Infinity */
const INFINITE_IDS = new Set([1, 2, 6, 7])

/** What a test runs on one engine: its SQL, and the drizzle database over it */
export type Engine = {
	exec(statement: string): Promise<void>
	ids(query: string): Promise<number[]>
}

/** One page under `order` after `cursor`: its ids and the next cursor */
export type Page = (order: string, cursor: string | undefined) => Promise<{ ids: number[]; next: string | null }>

type Builder = { select(): { from(table: typeof point): { $dynamic(): never } } }
type Relational = { query: { point: { findMany(options: never): Promise<unknown[]> } } }

/** A page read through buildListQuery */
export const viaBuilder =
	(db: Builder, options: CursorOptions = SEALED): Page =>
	async (order, cursor) => {
		const parsed = schema.parse({ cursor, order })
		const rows = await applyListQuery(
			db.select().from(point).$dynamic(),
			buildListQuery({ ...options, parsed, table: point }),
		)
		const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, built(parsed, options))
		return { ids: items.map((row) => row.id), next: meta.nextCursor }
	}

/** A page read through queryHelpers.listOptions and drizzle's findMany */
export const viaRelational =
	(db: Relational, options: CursorOptions = SEALED): Page =>
	async (order, cursor) => {
		const query = { ...schema.parse({ order }), cursor }
		const rows = await db.query.point.findMany(queryHelpers.listOptions(query, options) as never)
		const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, built(query, options))
		return { ids: items.map((row) => row.id), next: meta.nextCursor }
	}

/** `order` as SQL: its direction and null placement, the id breaking ties the same way */
function orderBy(order: string): { direction: string; nullsFirst: boolean } {
	const [, direction, nulls] = order.split(".") as [string, string, string | undefined]
	return { direction, nullsFirst: nulls === undefined ? direction === "desc" : nulls === "nullsfirst" }
}

/** The ids SQLite itself lists under `order` */
export function inOrder(engine: Engine, order: string): Promise<number[]> {
	const { direction, nullsFirst } = orderBy(order)
	return engine.ids(
		`SELECT id FROM point ORDER BY x ${direction} NULLS ${nullsFirst ? "FIRST" : "LAST"}, id ${direction}`,
	)
}

/** The ids after a NULL key on row `id` under `order`, in the table as it is now: where a plain null cursor resumes */
function afterNull(engine: Engine, order: string, id: number): Promise<number[]> {
	const { direction, nullsFirst } = orderBy(order)
	const later = `x IS NULL AND id ${direction === "asc" ? ">" : "<"} ${id}`
	const where = nullsFirst ? `(${later}) OR x IS NOT NULL` : later
	return engine.ids(
		`SELECT id FROM point WHERE ${where} ORDER BY x ${direction} NULLS ${nullsFirst ? "FIRST" : "LAST"}, id ${direction}`,
	)
}

/**
 * The ids a list resumes with once the null-keyed anchor `id` is gone: a null cursor may stand for
 * NULL, +Infinity or -Infinity, so it resumes from the earliest of them in the order (U24), NULL
 * where NULLs come first, else -Infinity ascending and +Infinity descending, repeating rows and
 * skipping none
 */
function afterGone(engine: Engine, order: string, id: number): Promise<number[]> {
	const { direction, nullsFirst } = orderBy(order)
	if (nullsFirst) return afterNull(engine, order, id)
	const [edge, op] = direction === "asc" ? ["-9e999", ">"] : ["9e999", "<"]
	const where = `x IS NULL OR x ${op} ${edge} OR (x = ${edge} AND id ${op} ${id})`
	return engine.ids(`SELECT id FROM point WHERE ${where} ORDER BY x ${direction} NULLS LAST, id ${direction}`)
}

/** How the first null-keyed row a page ends on is edited before the next page: a D1 ±Infinity reads as null too */
export type Edit = "delete" | "set to 5"

/**
 * Every id `page` serves under `order`, and the ids it should: SQLite's own order, or, once `edit`
 * changed the first NULL-keyed anchor, the ids before it and then those after where its NULL stood
 */
export async function pageAll(
	engine: Engine,
	page: Page,
	{
		edit,
		exact = false,
		infinities = false,
		order,
	}: { edit?: Edit | undefined; exact?: boolean; infinities?: boolean; order: string },
): Promise<{ expected: number[]; seen: number[] }> {
	let expected = await inOrder(engine, order)
	const seen: number[] = []
	let edited = false
	let cursor: string | undefined
	for (let guard = 0; guard < 15; guard++) {
		const { ids, next } = await page(order, cursor)
		seen.push(...ids)
		if (next === null) return { expected, seen }
		const last = ids.at(-1) as number
		if (edit !== undefined && !edited && (NULL_IDS.has(last) || (infinities && INFINITE_IDS.has(last)))) {
			edited = true
			await engine.exec(
				edit === "delete" ? `DELETE FROM point WHERE id = ${last}` : `UPDATE point SET x = 5 WHERE id = ${last}`,
			)
			/* a gone anchor resumes from the earliest reading of its null, unless the driver reads ±Infinity exactly */
			expected = [...seen, ...(await (edit === "delete" && !exact ? afterGone : afterNull)(engine, order, last))]
		}
		cursor = next
	}
	throw new Error(`${order} did not end in 15 pages: ${seen.join(" ")}`)
}
