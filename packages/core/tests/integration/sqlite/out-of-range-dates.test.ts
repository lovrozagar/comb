/**
 * AB3-9 of area B on libsql: a SQLite timestamp holding a finite value past a JS Date's range,
 * ±8.64e15 milliseconds, reads as an Invalid Date, as ±Infinity does. Bounded from its row as an
 * infinity, the finite row resumed the list from the direction's own end, so every page served the
 * first row again without end. Each walk serves one row a page, and again deleting each page's row
 * before the next.
 */
import { createClient } from "@libsql/client"
import { defineRelations, eq, getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildDerivedListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"

const MODES = { timestamp: 1000, timestamp_ms: 1 } as const
const KINDS = ["table", "anchored own", "listOptions"] as const
const SERVED = { asc: ["c", "a", "b"], desc: ["b", "a", "c"] } as const
const schema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["k"] })

type Mode = keyof typeof MODES
type Parsed = ReturnType<typeof schema.parse>

const tableOf = (mode: Mode) => sqliteTable("t", { id: text("id").primaryKey(), k: integer("k", { mode }) })

/** A database holding three rows past a Date's range, their ids out of key order */
async function holding(mode: Mode) {
	const client = createClient({ url: ":memory:" })
	const unit = MODES[mode]
	await client.execute("CREATE TABLE t (id text PRIMARY KEY, k integer)")
	await client.execute(`INSERT INTO t VALUES ('c', ${8.7e15 / unit}), ('a', ${8.8e15 / unit}), ('b', ${8.9e15 / unit})`)
	const t = tableOf(mode)
	return { client, db: drizzle({ client, relations: defineRelations({ t }) }), t }
}

type Held = Awaited<ReturnType<typeof holding>>

/** One page of the list `kind` builds for `parsed`, and its next cursor */
async function pageOf(
	{ db, t }: Held,
	kind: (typeof KINDS)[number],
	parsed: Parsed,
): Promise<[string[], string | null]> {
	if (kind === "listOptions") {
		const options = queryHelpers.listOptions(parsed, SEALED)
		const [items, meta] = queryHelpers.paginate(await db.query.t.findMany(options as never), options)
		return [items.map((row) => row.id), meta.nextCursor]
	}
	const list =
		kind === "table"
			? buildListQuery({ ...SEALED, parsed, table: t })
			: buildDerivedListQuery({ ...SEALED, anchor: { idColumn: t.id, table: t }, parsed, sortColumns: { k: t.k } })
	const rows = await applyListQuery((extras) => db.select({ ...getTableColumns(t), ...extras }).from(t), list)
	const [items, meta] = queryHelpers.paginate(rows, list)
	return [items.map((row) => row["id"] as string), meta.nextCursor]
}

type Walk = { deleting: boolean; direction: "asc" | "desc" }

/** Every id the list `kind` serves `direction`, one a page, at most five pages, deleting each page's rows when `deleting` */
async function served(held: Held, kind: (typeof KINDS)[number], { deleting, direction }: Walk) {
	const ids: string[] = []
	let cursor: string | undefined
	for (let n = 0; n < 5; n++) {
		const [page, next] = await pageOf(held, kind, { ...schema.parse({ order: `k.${direction}` }), cursor })
		ids.push(...page)
		if (deleting) for (const id of page) await held.db.delete(held.t).where(eq(held.t.id, id))
		if (next === null) break
		cursor = next
	}
	return ids
}

describe("a SQLite timestamp past a Date's range pages, never repeating a row without end (AB3-9 of area B)", () => {
	it.each(KINDS)("pages the %s list every row once, in either mode", async (kind) => {
		for (const mode of Object.keys(MODES) as Mode[])
			for (const deleting of [false, true])
				for (const direction of ["asc", "desc"] as const) {
					const held = await holding(mode)
					try {
						expect(
							await served(held, kind, { deleting, direction }),
							`${mode} ${direction}${deleting ? " deleting" : ""}`,
						).toEqual(SERVED[direction])
					} finally {
						held.client.close()
					}
				}
	})
})
