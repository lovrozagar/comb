/**
 * Keyset pagination through queryHelpers.listOptions and paginate on a real Postgres. A
 * `timestamp` keeps microseconds by default while its cursor, a JS Date, keeps milliseconds, so the
 * key is compared at milliseconds and the id breaks the tie: every row comes back exactly once.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { bigint, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { describePg, usePg } from "../support/pg.ts"
import { SIGNED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const item = pgTable("item", {
	created: timestamp("created", { precision: 6 }).notNull(),
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
})
const schema = createListQuerySchema({ sort: ["created", "id"] })

describePg("keyset pagination on a microsecond timestamp (Q2)", () => {
	const sessions = usePg()

	it.each(["created.desc", "created.asc"])(
		"pages through six rows of one millisecond, %s, each row once",
		async (order) => {
			const client = sessions.pg()
			await client.query(
				"CREATE TEMP TABLE item (id integer PRIMARY KEY, name text NOT NULL, created timestamp(6) NOT NULL)",
			)
			await client.query(
				"INSERT INTO item SELECT g, 'r' || g, timestamp '2026-01-01 00:00:00.123000' + g * interval '1 microsecond' FROM generate_series(1, 6) g",
			)
			const db = drizzle({ client, relations: defineRelations({ item }) })
			const query = schema.parse({ limit: "2", order })
			const seen: string[] = []
			let cursor: string | undefined
			for (let page = 0; page < 8; page++) {
				const options = queryHelpers.listOptions({ ...query, cursor }, SIGNED)
				const rows = await db.query.item.findMany({
					limit: options.limit,
					offset: options.offset,
					orderBy: options.orderBy,
					where: options.where,
				} as never)
				const [items, meta] = queryHelpers.paginate(
					rows as Array<{ created: Date; id: number; name: string }>,
					{
						...query,
						cursor,
					},
					SIGNED,
				)
				seen.push(...items.map((row) => row.name))
				if (!meta.hasMore || meta.nextCursor === null) break
				cursor = meta.nextCursor
			}
			const all = ["r1", "r2", "r3", "r4", "r5", "r6"]
			expect(seen).toEqual(order.endsWith("desc") ? all.toReversed() : all)
		},
	)
})

const big = pgTable("big", {
	id: bigint("id", { mode: "bigint" }).primaryKey(),
	name: text("name").notNull(),
})
const bigSchema = createListQuerySchema({ sort: ["name", "id"] })

describePg("keyset pagination on a bigint id (Q5)", () => {
	const sessions = usePg()

	it("pages through ids past 2^53, minting and reading each cursor", async () => {
		const client = sessions.pg()
		await client.query("CREATE TEMP TABLE big (id bigint PRIMARY KEY, name text NOT NULL)")
		await client.query("INSERT INTO big SELECT 9007199254740990 + g, 'n' || g FROM generate_series(1, 5) g")
		const db = drizzle({ client, relations: defineRelations({ big }) })
		const query = bigSchema.parse({ limit: "2", order: "name.asc" })
		const seen: bigint[] = []
		let cursor: string | undefined
		for (let page = 0; page < 5; page++) {
			const options = queryHelpers.listOptions({ ...query, cursor }, SIGNED)
			const rows = await db.query.big.findMany({
				limit: options.limit,
				offset: options.offset,
				orderBy: options.orderBy,
				where: options.where,
			} as never)
			const [items, meta] = queryHelpers.paginate(
				rows as Array<{ id: bigint; name: string }>,
				{ ...query, cursor },
				SIGNED,
			)
			seen.push(...items.map((row) => row.id))
			if (!meta.hasMore || meta.nextCursor === null) break
			cursor = meta.nextCursor
		}
		expect(seen).toEqual([1n, 2n, 3n, 4n, 5n].map((n) => 9007199254740990n + n))
	})
})
