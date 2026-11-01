/// <reference types="bun-types" />
/**
 * U22 on bun:sqlite's default mode, which reads an integer past 2^53 as a rounded JS number: every
 * order pages each row of an INTEGER key past 2^53 once through both builders, and a tiebreak id
 * past 2^53 mints no cursor. tests/integration runs the same on D1.
 */
import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { CombError } from "../../src/error.ts"
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
} from "../integration/support/bigint.ts"

function seeded(seed: string) {
	const client = new Database(":memory:")
	client.run(CREATE)
	client.run(seed)
	return client
}

describe("keyset pagination over an integer key past 2^53, on bun:sqlite (U22)", () => {
	for (const via of ["buildListQuery", "listOptions"] as const) {
		for (const order of Object.keys(EXPECTED)) {
			it(`pages ${order} through ${via} every row once`, async () => {
				const client = seeded(KEYS)
				const page =
					via === "buildListQuery"
						? viaBuilder(drizzle({ client }) as never)
						: viaRelational(drizzle({ client, relations: bigRelations }) as never)
				expect(await pageAll(page, order)).toEqual(EXPECTED[order] as number[])
				client.close()
			})
		}
	}

	it("mints no cursor from a tiebreak id past 2^53, naming what reads it exactly", async () => {
		const client = seeded(IDS)
		const refused = await viaBuilder(drizzle({ client }) as never)("n.asc", undefined).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(CombError)
		expect((refused as CombError).errorKey).toBe("sort_not_wired")
		expect(String((refused as CombError).cause)).toMatch(EXACTLY)
		client.close()
	})
})

/* Q1 of r19: a derived list with no anchor table binds the key as the driver read it */
describe("a derived list over an integer key past 2^53, on bun:sqlite", () => {
	for (const order of Object.keys(EXPECTED)) {
		it(`refuses the page whose cursor would carry a rounded key under ${order}, where it skipped rows or repeated one`, async () => {
			const client = seeded(KEYS)
			const refused = await pageAll(viaDerived(drizzle({ client }) as never), order).catch((error: unknown) => error)
			expect(refused).toBeInstanceOf(CombError)
			expect((refused as CombError).errorKey).toBe("sort_not_wired")
			expect(String((refused as CombError).cause)).toMatch(ROUNDED)
			client.close()
		})

		it(`pages ${order} every row once with an anchor table, which it reads the exact key back from`, async () => {
			const client = seeded(KEYS)
			expect(await pageAll(viaDerived(drizzle({ client }) as never, true), order)).toEqual(EXPECTED[order] as number[])
			client.close()
		})

		it(`pages ${order} every row once where the keys are read as bigint (safeIntegers)`, async () => {
			const client = new Database(":memory:", { safeIntegers: true })
			client.run(CREATE)
			client.run(KEYS)
			const ids = await pageAll(viaDerived(drizzle({ client }) as never), order)
			expect(ids.map(Number)).toEqual(EXPECTED[order] as number[])
			client.close()
		})
	}
})
