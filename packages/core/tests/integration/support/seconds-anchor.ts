/**
 * U20 of the 0.13.0 round: a seconds-mode SQLite timestamp list, paged two rows at a time on any
 * SQLite engine, its cursor row changed after the first page: bumped to a later time, as an
 * updated_at bump does, or deleted and its id handed out again. The cursor's bound is the value it
 * was minted from, the row read only for what the Date cannot hold, so the list resumes where the
 * old value stood. No test framework is imported, so vitest and bun:test share it.
 */
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { built } from "../../../src/query/__fixtures__/built.ts"

export const event = sqliteTable("event", {
	at: integer("at", { mode: "timestamp" }).notNull(),
	id: integer("id").primaryKey(),
})
const pairs = createListQuerySchema({ sort: ["at"], pagination: { defaultLimit: 2, maxLimit: 2 } })

/* whole seconds after 1970, and fractions below the millisecond before it, where a Date's millisecond is (ms - 1, ms] */
const WHOLE = "(1, 1700000001), (2, 1700000002), (3, 1700000003), (4, 1700000004), (5, 1700000005), (6, 1700000006)"
const BEFORE_1970 = "(1, -3.2504), (2, -2.7506), (3, -1.2502), (4, -0.7501), (5, -0.2503), (6, 0.4)"

const keep = () => "SELECT 1"
const bump = (anchor: number) => `UPDATE event SET at = 1800000000 WHERE id = ${anchor}`
const recreate = (anchor: number) => [
	`DELETE FROM event WHERE id = ${anchor}`,
	`INSERT INTO event VALUES (${anchor}, 1600000000)`,
]

/** One case: its name, the rows, the order, the change after page 1, and every id the list must serve */
export type AnchorCase = {
	change: (anchor: number) => string | string[]
	name: string
	order: string
	rows: string
	want: number[]
}

export const ANCHOR_CASES: readonly AnchorCase[] = [
	{ change: bump, name: "at.asc, the anchor bumped", order: "at.asc", rows: WHOLE, want: [1, 2, 3, 4, 5, 6, 2] },
	{ change: bump, name: "at.desc, the anchor bumped", order: "at.desc", rows: WHOLE, want: [6, 5, 4, 3, 2, 1] },
	{
		change: recreate,
		name: "at.asc, the anchor's id given out again",
		order: "at.asc",
		rows: WHOLE,
		want: [1, 2, 3, 4, 5, 6],
	},
	{
		change: recreate,
		name: "at.desc, the anchor's id given out again",
		order: "at.desc",
		rows: WHOLE,
		want: [6, 5, 4, 3, 2, 1, 5],
	},
	{ change: keep, name: "at.asc before 1970, unchanged", order: "at.asc", rows: BEFORE_1970, want: [1, 2, 3, 4, 5, 6] },
	{
		change: keep,
		name: "at.desc before 1970, unchanged",
		order: "at.desc",
		rows: BEFORE_1970,
		want: [6, 5, 4, 3, 2, 1],
	},
	{
		change: bump,
		name: "at.asc before 1970, the anchor bumped",
		order: "at.asc",
		rows: BEFORE_1970,
		want: [1, 2, 3, 4, 5, 6, 2],
	},
	{
		change: bump,
		name: "at.desc before 1970, the anchor bumped",
		order: "at.desc",
		rows: BEFORE_1970,
		want: [6, 5, 4, 3, 2, 1],
	},
]

/** What a case runs on one engine: its SQL, and drizzle's select over it */
export type AnchorEngine = {
	exec(statement: string): Promise<void>
	db: { select(): { from(table: typeof event): { $dynamic(): never } } }
}

/** Every id the list serves on `engine`, seeded with `rows`, `change` run on the anchor once after the first page */
export async function servedAround(engine: AnchorEngine, { change, order, rows }: AnchorCase): Promise<number[]> {
	await engine.exec("CREATE TABLE event (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)")
	await engine.exec(`INSERT INTO event VALUES ${rows}`)
	const seen: number[] = []
	let cursor: string | undefined
	for (let page = 0; page < 12; page++) {
		const parsed = pairs.parse({ cursor, order })
		const found = await applyListQuery(
			engine.db.select().from(event).$dynamic(),
			buildListQuery({ ...SEALED, parsed, table: event }),
		)
		const [items, meta] = queryHelpers.paginate(found as Array<{ id: number }>, built(parsed, SEALED))
		seen.push(...items.map((row) => row.id))
		if (page === 0) for (const statement of [change(seen.at(-1) as number)].flat()) await engine.exec(statement)
		if (meta.nextCursor === null) return seen
		cursor = meta.nextCursor
	}
	throw new Error(`did not end in 12 pages: ${seen.join(" ")}`)
}
