/**
 * A list keyed by a REAL column, paged one row at a time through every builder that binds its keys
 * as the driver read them: a derived list with no anchor, and a merged list over shards, each with
 * the key a declared column and an expression (Q1 and Q3 of r20). A REAL is a double on disk, so
 * a value past 2^53 reads back exactly and pages; ±Infinity is a REAL too, which D1 reads as null.
 * One database's own ORDER BY is the truth. No test framework is imported, so bun:test can share it.
 */
import { getTableColumns, sql } from "drizzle-orm"
import { integer, real, sqliteTable } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { paginateMerged } from "../../../src/query/merged.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

export const point = sqliteTable("point", { id: integer("id").primaryKey(), x: real("x") })
export const CREATE = "CREATE TABLE point (id INTEGER PRIMARY KEY, x REAL)"
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["x"] })

/* past 2^53, every one integral and exact as a double, around two a lossy read could not tell apart */
export const PAST: Array<[number, string]> = [
	[1, "1e20"],
	[2, "2e20"],
	[3, "-3e20"],
	[4, "1.5"],
	[5, "9007199254740994"],
	[6, "9007199254740992"],
	[7, "NULL"],
]
/* ±Infinity on both shards, finite values and NULLs between them */
export const INFINITE: Array<[number, string]> = [
	[1, "9e999"],
	[2, "-9e999"],
	[3, "1.5"],
	[4, "NULL"],
	[5, "-2"],
	[6, "9e999"],
	[7, "-9e999"],
	[8, "NULL"],
]
export const ORDERS = ["x.asc", "x.desc", "x.asc.nullsfirst", "x.desc.nullslast"]

/** The rows as INSERT statements, the shard each row goes to beside it (its index, alternating) */
export const inserts = (rows: Array<[number, string]>): Array<[number, string]> =>
	rows.map(([id, x], i) => [i % 2, `INSERT INTO point VALUES (${id}, ${x})`])

/** The ids in `order` as SQLite orders them, the id breaking ties in the first key's direction */
export function truthQuery(order: string): string {
	const desc = order.includes("desc")
	const first = order.includes("nullsfirst") || (desc && !order.includes("nullslast"))
	return `SELECT id FROM point ORDER BY x ${desc ? "DESC" : "ASC"} NULLS ${first ? "FIRST" : "LAST"}, id ${desc ? "DESC" : "ASC"}`
}

/** A drizzle SQLite database, as any driver's select reads it: a promise of the rows */
type Db = { select(fields: object): { from(table: typeof point): { $dynamic(): never } } }
type Kind = "derived column" | "derived expression" | "merged column" | "merged expression"
export const KINDS: readonly Kind[] = ["derived column", "derived expression", "merged column", "merged expression"]

const named = (name: string) => sql`${sql.identifier(name)}`
/** The sort key and the tiebreak, as a declared column or as an expression with no column */
const keysOf = (kind: Kind) =>
	kind.endsWith("column")
		? { idColumn: point.id, sortColumns: { x: point.x } }
		: { dialect: "sqlite" as const, idColumn: named("id"), sortColumns: { x: named("x") } }

/**
 * Every id `kind` pages under `order`, by cursor or by page number, reading `one` for a derived list
 * and `shards` for a merged one; at most twelve pages, so a loop shows as a repeat
 */
export async function pageAll(
	kind: Kind,
	{ mode, one, order, shards }: { mode: "cursor" | "page"; one: Db; order: string; shards: readonly Db[] },
): Promise<number[]> {
	const read = (db: Db, built: never) =>
		applyListQuery(
			(extras) => db.select({ ...getTableColumns(point), ...extras }).from(point),
			built,
		) as unknown as Promise<Array<{ id: number }>>
	const seen: number[] = []
	let cursor: string | undefined
	for (let p = 1; p <= 12; p++) {
		const parsed = schema.parse({ order, ...(mode === "cursor" ? { cursor } : { page: String(p) }) })
		const keys = keysOf(kind)
		const [items, meta] = kind.startsWith("merged")
			? await (async () => {
					const built = buildDerivedListQuery({ ...SEALED, ...keys, merged: {}, parsed })
					return paginateMerged(await Promise.all(shards.map((db) => read(db, built as never))), built)
				})()
			: await (async () => {
					const built = buildDerivedListQuery({ ...SEALED, ...keys, parsed })
					return queryHelpers.paginate(await read(one, built as never), built)
				})()
		seen.push(...items.map((row) => row.id))
		if (mode === "cursor" ? meta.nextCursor === null : !meta.hasMore) break
		cursor = meta.nextCursor ?? undefined
	}
	return seen
}
