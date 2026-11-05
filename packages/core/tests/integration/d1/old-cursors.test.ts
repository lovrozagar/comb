/**
 * AB4-7 of area B on D1: a cursor comb minted before a SQLite REAL key carried its text opens and
 * pages the rows after it (support/old-cursor-walk.ts). tests/integration/sqlite runs the same on libsql.
 */
import { drizzle } from "drizzle-orm/d1"
import { afterEach, describe, expect, it } from "vitest"
import { type D1Harness, d1Memory } from "../support/d1.ts"
import { oldSeed, oldWalkProblems } from "../support/old-cursor-walk.ts"
import { OLD_WALKS } from "../support/old-cursors.ts"

const shards: D1Harness[] = []
afterEach(async () => {
	await Promise.all(shards.splice(0).map((shard) => shard.dispose()))
})

describe("a cursor an older comb minted pages on, on D1 (AB4-7 of area B)", () => {
	it.each(OLD_WALKS.map((walk) => [`${walk.rev} ${walk.rows} ${walk.shape} ${walk.direction}`, walk] as const))(
		"%s",
		async (_, walk) => {
			const shard = await d1Memory()
			shards.push(shard)
			for (const statement of oldSeed(walk)) await shard.CORE.prepare(statement).run()
			expect(await oldWalkProblems(drizzle(shard.CORE) as never, walk)).toEqual([])
		},
	)
})
