/**
 * PA17 of r22b, with Postgres 17 as the oracle: a move of a relation to where its history put it
 * rewrites nothing, and comb warns of nothing for it; a move that changes where it is rewrites it,
 * and comb warns of the rewrite. Each case's history runs on a scratch database, and its relation's
 * relfilenode is read before and after the move: a new one is a rewrite. The history names the
 * access method and tablespace each relation has (heap, pg_default), as comb reads them only where it
 * does (classify.pg-moves.test.ts).
 */
import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import { classifyMigration } from "../../../src/migrate/core/classify.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { extractSchema } from "../../../src/migrate/core/schema.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

const PLACED = "CREATE TABLE t (id int) USING heap TABLESPACE pg_default;"
const UNLOGGED = "CREATE UNLOGGED TABLE t (id int) USING heap TABLESPACE pg_default;"
const VIEW = "CREATE MATERIALIZED VIEW t USING heap TABLESPACE pg_default AS SELECT 1 AS id;"
const INDEXED = "CREATE TABLE b (id int);\nCREATE INDEX t ON b (id) TABLESPACE pg_default;"

// lookup-table: each history, the move run after it, and whether Postgres rewrites the relation t for it
const MOVES: ReadonlyArray<readonly [string, string, boolean]> = [
	[PLACED, "ALTER TABLE t SET LOGGED", false],
	[PLACED, "ALTER TABLE t SET ACCESS METHOD heap", false],
	[PLACED, "ALTER TABLE t SET TABLESPACE pg_default", false],
	[UNLOGGED, "ALTER TABLE t SET UNLOGGED", false],
	[VIEW, "ALTER MATERIALIZED VIEW t SET ACCESS METHOD heap", false],
	[VIEW, "ALTER MATERIALIZED VIEW t SET TABLESPACE pg_default", false],
	[INDEXED, "ALTER INDEX t SET TABLESPACE pg_default", false],
	[`${PLACED}\nALTER TABLE t SET UNLOGGED;`, "ALTER TABLE t SET UNLOGGED", false],
	[UNLOGGED, "ALTER TABLE t SET LOGGED", true],
	[PLACED, "ALTER TABLE t SET UNLOGGED", true],
]

/** t's relfilenode after `history`, and after `move` on top of it */
function files(history: string, move: string): Promise<[string, string]> {
	return withScratchDb(async (url) => {
		const client = new pg.Client({ connectionString: url })
		await client.connect()
		try {
			await client.query(history)
			const read = async () =>
				(await client.query<{ f: string }>("SELECT relfilenode::text AS f FROM pg_class WHERE relname = 't'")).rows[0]
					?.f as string
			const before = await read()
			await client.query(move)
			return [before, await read()]
		} finally {
			await client.end()
		}
	})
}

describe("a move of a relation against Postgres 17 (PA17 of r22b)", () => {
	it.each(MOVES)("after %j, %j rewrites t: %s, and comb warns of it exactly then", async (history, move, rewrites) => {
		const [before, after] = await files(history, move)
		expect(before !== after).toBe(rewrites)
		const rated = classifyMigration(`${move};`, {
			before: extractSchema(history, undefined, "postgres"),
			dialect: "postgres",
		})
		expect(rated.lockWarnings.length > 0).toBe(rewrites)
	})
})
