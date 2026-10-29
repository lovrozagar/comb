/**
 * Q2 of r17 (N9, refined): the next cursor's id is the value the list breaks ties on, which the
 * builder selects itself as `_combId`. A row's own id, here a child's beside the parent the list
 * orders by, never reaches the cursor, so the list neither repeats nor skips a row.
 */
import { eq } from "drizzle-orm"
import { alias, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { queryHelpers } from "../../../src/query/drizzle.ts"
import { buildDerivedListQuery } from "../../../src/query/sqlite/build-list-query.ts"
import { libsqlMemory } from "../support/libsql.ts"
import { SEALED } from "../../../src/query/__fixtures__/cursor-secret.ts"

const node = sqliteTable("node", { id: text("id").primaryKey(), notes: text("notes"), parent: text("parent") })
const par = alias(node, "par")

/* two parents share a sort value, and each child's id sorts after every parent's */
const NODES: Array<[string, string, string | null]> = [
	["p1", "m", null],
	["p2", "m", null],
	["p3", "a", null],
	["z1", "q", "p1"],
	["z2", "q", "p2"],
	["y3", "q", "p3"],
]

describe("a derived list whose rows' own id is not its tiebreak (Q2)", () => {
	it.each([
		["with no anchor", { idColumn: par.id }],
		["anchored on the parent", { anchor: { idColumn: par.id, table: par } }],
	])("pages a self-join by the parent it orders by, %s, every child once", async (_label, wiring) => {
		const harness = libsqlMemory()
		try {
			await harness.client.execute("CREATE TABLE node (id TEXT PRIMARY KEY, notes TEXT, parent TEXT)")
			for (const args of NODES) await harness.client.execute({ args, sql: "INSERT INTO node VALUES (?, ?, ?)" })
			const seen: string[] = []
			let cursor: string | undefined
			for (let n = 0; n < 6; n++) {
				const built = buildDerivedListQuery({
					...SEALED,
					...wiring,
					parsed: { cursor, limit: 1, parsedSort: [{ direction: "asc", field: "notes" }], validated: true },
					sortColumns: { notes: par.notes },
				})
				const query = harness.db
					.select({ id: node.id, notes: par.notes, ...built.extras })
					.from(par)
					.innerJoin(node, eq(node.parent, par.id))
				const rows = await (built.where === undefined ? query : query.where(built.where))
					.orderBy(...built.orderBy)
					.limit(built.limit)
					.offset(built.offset)
				const [items, meta] = queryHelpers.paginate(rows, built)
				seen.push(...items.map((row) => row.id))
				if (meta.nextCursor === null) break
				cursor = meta.nextCursor
			}
			expect(seen).toEqual(["y3", "z1", "z2"])
		} finally {
			harness.close()
		}
	})
})
