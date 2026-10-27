/**
 * Keyset pagination through queryHelpers.listOptions and paginate on a real Postgres. A
 * `timestamp` keeps microseconds by default while its cursor, a JS Date, keeps milliseconds, so the
 * key is compared at milliseconds and the id breaks the tie: every row comes back exactly once.
 */
import { defineRelations } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { bigint, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../../src/query/schema.ts"
import { usePg } from "../support/pg.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const item = pgTable("item", {
	created: timestamp("created", { precision: 6 }).notNull(),
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
})
const schema = createListQuerySchema({ sort: ["created", "id"] })

describe("keyset pagination on a microsecond timestamp (Q2)", () => {
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
				const options = queryHelpers.listOptions({ ...query, cursor }, SEALED)
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
					SEALED,
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

describe("keyset pagination on a bigint id (Q5)", () => {
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
			const options = queryHelpers.listOptions({ ...query, cursor }, SEALED)
			const rows = await db.query.big.findMany({
				limit: options.limit,
				offset: options.offset,
				orderBy: options.orderBy,
				where: options.where,
			} as never)
			const [items, meta] = queryHelpers.paginate(
				rows as Array<{ id: bigint; name: string }>,
				{ ...query, cursor },
				SEALED,
			)
			seen.push(...items.map((row) => row.id))
			if (!meta.hasMore || meta.nextCursor === null) break
			cursor = meta.nextCursor
		}
		expect(seen).toEqual([1n, 2n, 3n, 4n, 5n].map((n) => 9007199254740990n + n))
	})
})

/* U22: drizzle's bigint in number mode reads 9007199254740993 as …992, so the keyset reads the exact key from the row */
const counter = pgTable("counter", { id: integer("id").primaryKey(), n: bigint("n", { mode: "number" }).notNull() })
const counterSchema = createListQuerySchema({ pagination: { defaultLimit: 1, maxLimit: 1 }, sort: ["n"] })

describe("keyset pagination on a bigint key past 2^53 read in number mode (U22)", () => {
	const sessions = usePg()

	it.each([
		["n.asc", [1, 5, 2, 3, 4]],
		["n.desc", [4, 3, 2, 5, 1]],
	] as const)("pages %s each row once", async (order, expected) => {
		const client = sessions.pg()
		await client.query("CREATE TEMP TABLE counter (id integer PRIMARY KEY, n bigint NOT NULL)")
		await client.query(
			"INSERT INTO counter VALUES (1, 1), (2, 9007199254740993), (3, 9007199254740995), (4, 9007199254740997), (5, 100)",
		)
		const db = drizzle({ client, relations: defineRelations({ counter }) })
		const seen: number[] = []
		let cursor: string | undefined
		for (let page = 0; page < 12; page++) {
			const query = { ...counterSchema.parse({ order }), cursor }
			const rows = await db.query.counter.findMany(queryHelpers.listOptions(query, SEALED) as never)
			const [items, meta] = queryHelpers.paginate(rows as Array<{ id: number; n: number }>, query, SEALED)
			seen.push(...items.map((row) => row.id))
			if (meta.nextCursor === null) break
			cursor = meta.nextCursor
		}
		expect(seen).toEqual(expected)
	})
})
