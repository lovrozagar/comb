/**
 * U10 of the 0.12 round: a seconds-mode timestamp holding a fractional second, as
 * `unixepoch('subsec')` or any SQL but drizzle's writes it. The cursor's Date keeps milliseconds;
 * bound through drizzle's mapper it would floor to the second, and the row would compare greater
 * than its own cursor. Every order pages each row once through both builders.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { libsqlMemory } from "../support/libsql.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"
import { ANCHOR_CASES, servedAround } from "../support/seconds-anchor.ts"

const event = sqliteTable("event", {
	at: integer("at", { mode: "timestamp" }).notNull(),
	id: integer("id").primaryKey(),
})
const schema = createListQuerySchema({ sort: ["at"], pagination: { defaultLimit: 1, maxLimit: 1 } })

async function seeded() {
	const harness = libsqlMemory()
	await harness.client.executeMultiple(
		"CREATE TABLE event (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);\nINSERT INTO event VALUES (1, 1700000000.25), (2, 1700000000.75), (3, 1700000001), (4, 1699999999.5), (5, 1700000000.1234567), (6, 1700000000.1234568);",
	)
	return harness
}

type Page = (cursor: string | undefined) => Promise<{ ids: number[]; next: string | null }>

async function pageAll(page: Page): Promise<number[]> {
	const seen: number[] = []
	let cursor: string | undefined
	for (let guard = 0; guard < 12; guard++) {
		const { ids, next } = await page(cursor)
		seen.push(...ids)
		if (next === null) return seen
		cursor = next
	}
	throw new Error(`did not end in 12 pages: ${seen.join(" ")}`)
}

describe("keyset pagination on a seconds-mode timestamp holding fractions (U10)", () => {
	it.each([
		["at.asc", [4, 5, 6, 1, 2, 3]],
		["at.desc", [3, 2, 1, 6, 5, 4]],
	])("pages %s exactly through buildListQuery and listOptions", async (order, want) => {
		const harness = await seeded()
		try {
			const built = await pageAll(async (cursor) => {
				const parsed = schema.parse({ cursor, order })
				const rows = await applyListQuery(
					harness.db.select().from(event).$dynamic(),
					buildListQuery({ ...SEALED, parsed, table: event }),
				)
				const [items, meta] = queryHelpers.paginate(rows, parsed, SEALED)
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			})
			expect(built).toEqual(want)
			const db = drizzle({ client: harness.client, relations: defineRelations({ event }) })
			const relational = await pageAll(async (cursor) => {
				const query = { ...schema.parse({ order }), cursor }
				const rows = await db.query.event.findMany(queryHelpers.listOptions(query, SEALED) as never)
				const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number }>, query, SEALED)
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			})
			expect(relational).toEqual(want)
		} finally {
			harness.close()
		}
	})
})

/* the 3.3 review of U10: a fraction below a millisecond, which no Date holds, is read from the cursor's row;
   once that row is gone the cursor's milliseconds bound it, toward repeating a row of that millisecond, never skipping one */
describe("keyset pagination on a seconds-mode timestamp, its cursor row deleted", () => {
	it.each([
		["at.asc", [4, 5, 6, 1, 2, 3]],
		["at.desc", [3, 2, 1, 6, 5, 4]],
	])("pages %s on from the cursor's milliseconds once its row is gone", async (order, want) => {
		const harness = await seeded()
		try {
			let deleted = false
			const seen = await pageAll(async (cursor) => {
				const parsed = schema.parse({ cursor, order })
				const rows = await applyListQuery(
					harness.db.select().from(event).$dynamic(),
					buildListQuery({ ...SEALED, parsed, table: event }),
				)
				const [items, meta] = queryHelpers.paginate(rows, parsed, SEALED)
				/* the first row a page ends on whose fraction no Date holds goes before the next page */
				const last = items.at(-1)?.id
				if (!deleted && (last === 5 || last === 6)) {
					deleted = true
					await harness.client.execute({ args: [last], sql: "DELETE FROM event WHERE id = ?" })
				}
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			})
			expect(seen).toEqual(want)
		} finally {
			harness.close()
		}
	})
})

/** A table of times before 1970, two in one millisecond, and one at the epoch */
async function negative() {
	const harness = libsqlMemory()
	await harness.client.executeMultiple(
		"CREATE TABLE event (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);\nINSERT INTO event VALUES (1, -1.5), (2, -1.4999), (3, -1.4995), (4, 0);",
	)
	return harness
}

/* the 3.3 review of U10: before 1970 a Date truncates toward zero, its milliseconds the ceiling of the stored value */
describe("keyset pagination on a seconds-mode timestamp before 1970, its cursor row deleted", () => {
	it.each([
		["at.asc", [1, 2, 3, 4], undefined],
		["at.desc", [4, 3, 2, 1], undefined],
		["at.asc", [1, 2, 3, 4], 2],
		["at.desc", [4, 3, 2, 1], 3],
	] as const)("pages %s exactly to %j, deleting row %s once a page ends on it", async (order, want, gone) => {
		const harness = await negative()
		try {
			const seen = await pageAll(async (cursor) => {
				const parsed = schema.parse({ cursor, order })
				const rows = await applyListQuery(
					harness.db.select().from(event).$dynamic(),
					buildListQuery({ ...SEALED, parsed, table: event }),
				)
				const [items, meta] = queryHelpers.paginate(rows, parsed, SEALED)
				if (gone !== undefined && items.at(-1)?.id === gone)
					await harness.client.execute({ args: [gone], sql: "DELETE FROM event WHERE id = ?" })
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			})
			expect(seen).toEqual(want)
		} finally {
			harness.close()
		}
	})
})

/* the 3.3 review of U10: a Date of 0 is any stored value within a millisecond of the epoch, on either side */
describe("keyset pagination on a seconds-mode timestamp at the epoch, its cursor row deleted", () => {
	it.each([
		["at.asc", [1, 2, 3, 4, 5, 6], 2],
		["at.desc", [6, 5, 4, 3, 2, 1], 5],
	] as const)("pages %s exactly to %j, deleting row %s once a page ends on it", async (order, want, gone) => {
		const harness = libsqlMemory()
		await harness.client.executeMultiple(
			"CREATE TABLE event (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);\nINSERT INTO event VALUES (1, -1), (2, -0.0008), (3, -0.0005), (4, 0.0005), (5, 0.0008), (6, 1);",
		)
		try {
			const seen = await pageAll(async (cursor) => {
				const parsed = schema.parse({ cursor, order })
				const rows = await applyListQuery(
					harness.db.select().from(event).$dynamic(),
					buildListQuery({ ...SEALED, parsed, table: event }),
				)
				const [items, meta] = queryHelpers.paginate(rows, parsed, SEALED)
				if (items.at(-1)?.id === gone)
					await harness.client.execute({ args: [gone], sql: "DELETE FROM event WHERE id = ?" })
				return { ids: items.map((row) => row.id), next: meta.nextCursor }
			})
			expect(seen).toEqual(want)
		} finally {
			harness.close()
		}
	})
})

/* U20 of the 0.13.0 round, on libsql: the shared cases (support/seconds-anchor.ts) */
describe("keyset pagination on a seconds-mode timestamp whose cursor row changes between pages (U20)", () => {
	it.each(ANCHOR_CASES)("pages $name exactly", async (one) => {
		const harness = libsqlMemory()
		try {
			const engine = {
				db: harness.db as never,
				exec: async (statement: string) => {
					await harness.client.execute(statement)
				},
			}
			expect(await servedAround(engine, one)).toEqual(one.want)
		} finally {
			harness.close()
		}
	})
})
