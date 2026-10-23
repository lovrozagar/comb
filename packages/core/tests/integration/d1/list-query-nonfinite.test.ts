/**
 * D1 hands a REAL ±Infinity over as null, its transport being JSON (U4), so a cursor minted from
 * such a row carries null and the keyset reads the value back from the row. Every order pages each
 * row once through both builders, and a NULL-keyed anchor deleted or set to 5 between pages
 * resumes from where its NULL stood.
 */
import { drizzle } from "drizzle-orm/d1"
import { afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import {
	type Edit,
	type Engine,
	ORDERS,
	pageAll,
	pointRelations,
	SEED,
	viaBuilder,
	viaRelational,
} from "../support/nonfinite.ts"

let harness: D1Harness | undefined
afterEach(async () => {
	await harness?.dispose()
	harness = undefined
})

/** A Miniflare D1, seeded */
async function seeded() {
	harness = await d1Memory()
	const d1 = harness.CORE
	for (const statement of SEED) await d1.prepare(statement).run()
	const engine: Engine = {
		exec: async (statement) => {
			await d1.prepare(statement).run()
		},
		ids: async (query) => (await d1.prepare(query).all<{ id: number }>()).results.map((row) => row.id),
	}
	return {
		engine,
		pages: {
			buildListQuery: viaBuilder(drizzle(d1) as never),
			listOptions: viaRelational(drizzle(d1, { relations: pointRelations }) as never),
		},
	}
}

describe("keyset pagination on ±Infinity and NULL in a SQLite REAL, on D1 (U4)", () => {
	it("reads ±Infinity as null, as the keyset must allow for", async () => {
		const { engine } = await seeded()
		const rows = await (harness as D1Harness).CORE.prepare("SELECT x, typeof(x) AS t FROM point WHERE id = 1").all()
		expect(rows.results).toEqual([{ t: "real", x: null }])
		expect(await engine.ids("SELECT id FROM point WHERE x = 9e999 ORDER BY id")).toEqual([1, 6])
	})

	for (const via of ["buildListQuery", "listOptions"] as const) {
		for (const edit of [undefined, "delete", "set to 5"] as Array<Edit | undefined>) {
			it.each(ORDERS)(
				`pages %s through ${via} every row once${edit ? `, its NULL anchor's row ${edit}` : ""}`,
				async (order) => {
					const { engine, pages } = await seeded()
					const { expected, seen } = await pageAll(engine, pages[via], { edit, order })
					expect(seen).toEqual(expected)
				},
			)
		}
	}
})
