/**
 * U22 on D1, whose JSON transport reads 9007199254740993 as …992: every order pages each row of an
 * INTEGER key past 2^53 once through both builders, and a tiebreak id past 2^53 mints no cursor.
 * tests/bun runs the same on bun:sqlite's default mode.
 */
import type { D1Database } from "@cloudflare/workers-types"
import { drizzle } from "drizzle-orm/d1"
import { Miniflare } from "miniflare"
import { afterEach, describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import {
	bigRelations,
	CREATE,
	EXACTLY,
	EXPECTED,
	IDS,
	KEYS,
	pageAll,
	ROUNDED,
	viaBuilder,
	viaDerived,
	viaRelational,
} from "../support/bigint.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import {
	CREATE as CREATE_POINT,
	inserts,
	KINDS,
	ORDERS,
	PAST,
	pageAll as pageReals,
	truthQuery,
} from "../support/real-keys.ts"

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

async function d1(seed: string) {
	harness = await d1Memory()
	await harness.CORE.prepare(CREATE).run()
	await harness.CORE.prepare(seed).run()
	return harness.CORE
}

describe("keyset pagination over an integer key past 2^53, on D1 (U22)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		it.each(Object.keys(EXPECTED))(`pages %s through ${via} every row once`, async (order) => {
			const database = await d1(KEYS)
			const page =
				via === "buildListQuery"
					? viaBuilder(drizzle(database) as never)
					: viaRelational(drizzle(database, { relations: bigRelations }) as never)
			expect(await pageAll(page, order)).toEqual(EXPECTED[order])
		})
	}

	it("mints no cursor from a tiebreak id past 2^53, naming what reads it exactly", async () => {
		const database = await d1(IDS)
		const refused = await viaBuilder(drizzle(database) as never)("n.asc", undefined).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(CombError)
		expect((refused as CombError).errorKey).toBe("sort_not_wired")
		expect(String((refused as CombError).cause)).toMatch(EXACTLY)
	})
})

/* Q1 of r19: D1 reads every INTEGER as a JS number, so a derived list with no anchor table cannot page such a key */
describe("a derived list over an integer key past 2^53, on D1", () => {
	it.each(Object.keys(EXPECTED))(
		"refuses the page whose cursor would carry a rounded key under %s, where it skipped rows or repeated one",
		async (order) => {
			const database = await d1(KEYS)
			const refused = await pageAll(viaDerived(drizzle(database) as never), order).catch((error: unknown) => error)
			expect(refused).toBeInstanceOf(CombError)
			expect((refused as CombError).errorKey).toBe("sort_not_wired")
			expect(String((refused as CombError).cause)).toMatch(ROUNDED)
		},
	)

	it.each(Object.keys(EXPECTED))(
		"pages %s every row once with an anchor table, which it reads the exact key back from",
		async (order) => {
			const database = await d1(KEYS)
			expect(await pageAll(viaDerived(drizzle(database) as never, true), order)).toEqual(EXPECTED[order])
		},
	)
})

/* Q1 of r20: a REAL is a double on disk, so a key past 2^53 reads back exactly, and lists that bind it as read page it */
describe("a REAL key past 2^53, on D1", () => {
	let mf: Miniflare | undefined
	afterEach(async () => {
		await mf?.dispose()
		mf = undefined
	})

	for (const kind of KINDS)
		it.each(ORDERS)(`pages %s through a ${kind} list every row once, by cursor and by page`, async (order) => {
			mf = new Miniflare({
				d1Databases: ["S0", "S1", "ONE"],
				modules: true,
				script: "export default { fetch() { return new Response(null, { status: 204 }) } }",
			})
			const [s0, s1, one] = (await Promise.all(
				["S0", "S1", "ONE"].map((name) => mf?.getD1Database(name)),
			)) as unknown as D1Database[]
			for (const db of [s0, s1, one]) await db?.prepare(CREATE_POINT).run()
			for (const [shard, insert] of inserts(PAST))
				for (const db of [[s0, s1][shard], one]) await db?.prepare(insert).run()
			const truth = (await one?.prepare(truthQuery(order)).all<{ id: number }>())?.results.map(({ id }) => id)
			const dbs = {
				one: drizzle(one as D1Database) as never,
				shards: [drizzle(s0 as D1Database), drizzle(s1 as D1Database)] as never,
			}
			for (const mode of ["cursor", "page"] as const)
				expect(await pageReals(kind, { ...dbs, mode, order }), mode).toEqual(truth)
		})
})
