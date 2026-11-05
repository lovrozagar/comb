/**
 * AB4-7 of area B on libsql: a cursor comb minted before a SQLite REAL key carried its text opens and
 * pages the rows after it (support/old-cursor-walk.ts). tests/integration/d1 runs the same on D1.
 */
import { type Client, createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"
import { oldSeed, oldWalkProblems } from "../support/old-cursor-walk.ts"
import { OLD_WALKS } from "../support/old-cursors.ts"

const clients: Client[] = []
afterEach(() => {
	for (const client of clients.splice(0)) client.close()
})

describe("a cursor an older comb minted pages on, on libsql (AB4-7 of area B)", () => {
	it.each(OLD_WALKS.map((walk) => [`${walk.rev} ${walk.rows} ${walk.shape} ${walk.direction}`, walk] as const))(
		"%s",
		async (_, walk) => {
			const client = createClient({ url: ":memory:" })
			clients.push(client)
			for (const statement of oldSeed(walk)) await client.execute(statement)
			expect(await oldWalkProblems(drizzle({ client }) as never, walk)).toEqual([])
		},
	)
})
