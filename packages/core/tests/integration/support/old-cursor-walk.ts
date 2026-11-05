/**
 * AB4-7 of area B: a cursor an older comb minted (old-cursors.ts), holding a SQLite REAL key as a
 * number, opens and pages the rows after it as that version paged them, now a cursor carries the
 * key's text. Each engine's suite opens the rows on its own driver.
 */
import { sql } from "drizzle-orm"
import { integer, type SQLiteAsyncDatabase, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import type { OldWalk } from "./old-cursors.ts"

const post = sqliteTable("post", { id: text("id").primaryKey(), s: integer("s", { mode: "timestamp" }) })
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["s"] })

/** The rows each walk was minted over: seconds as SQLite stores them, past where D1 prints them and a REAL JS writes in 17 digits */
const ROWS: Record<OldWalk["rows"], string> = {
	huge: "('a', 1000), ('b', 1e300), ('c', 9e999), ('d', 2000), ('e', 1e-300), ('f', 1000.5)",
	plain: "('a', 1000), ('d', 2000), ('f', 1000.5), ('g', 0.30000000000000004)",
}

/** The statements that seed the rows `walk` was minted over */
export const oldSeed = (walk: OldWalk): string[] => [
	"CREATE TABLE post (id TEXT PRIMARY KEY, s INTEGER)",
	`INSERT INTO post VALUES ${ROWS[walk.rows]}`,
]

type Db = SQLiteAsyncDatabase<any, any>

/** The ids of one page of `walk`'s list, read from `cursor`, and its next cursor */
async function pageAfter(db: Db, walk: OldWalk, cursor: string): Promise<readonly [string[], string | null]> {
	const parsed = { ...schema.parse({ order: `s.${walk.direction}` }), cursor }
	const list =
		walk.shape === "table"
			? buildListQuery({ ...SEALED, parsed, table: post })
			: buildDerivedListQuery({
					...SEALED,
					...(walk.shape === "anchorless" ? { idColumn: post.id } : { anchor: { idColumn: post.id, table: post } }),
					parsed,
					sortColumns: { s: post.s },
				})
	const rows = await applyListQuery(
		(extras: object) => db.select({ id: post.id, s: post.s, ...extras }).from(post),
		list,
	)
	const [items, meta] = queryHelpers.paginate(rows, list)
	return [items.map((row) => (row as { id: string }).id), meta.nextCursor]
}

/**
 * What breaks the rule each of `walk`'s cursors keeps on `db`: it pages, one row a page, every row
 * SQLite orders after the one it was minted after, once, then ends. One line a broken cursor
 */
export async function oldWalkProblems(db: Db, walk: OldWalk): Promise<string[]> {
	const order = (
		(await db.all(sql.raw(`SELECT id FROM post ORDER BY s ${walk.direction}, id ${walk.direction}`))) as unknown[]
	).map((row) => (Array.isArray(row) ? row[0] : (row as { id: string }).id) as string)
	const problems: string[] = []
	for (const [i, minted] of walk.cursors.entries()) {
		const ids: string[] = []
		let cursor: string | null = minted
		try {
			for (let n = 0; cursor !== null && n <= order.length; n++) {
				const [page, next] = await pageAfter(db, walk, cursor)
				ids.push(...page)
				cursor = next
			}
		} catch (error) {
			ids.push(`then ${(error as { errorKey?: string }).errorKey ?? String(error)}`)
		}
		const after = order.slice(i + 1)
		if (ids.join() !== after.join())
			problems.push(
				`${walk.rev} ${walk.rows} ${walk.shape} ${walk.direction} cursor ${i}: served ${ids.join()} of ${after.join()}`,
			)
	}
	return problems
}
