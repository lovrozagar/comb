/**
 * P1 of r21: in a `-- atlas:txmode none` file the dev replay runs each statement a transaction allows
 * in one of its own, and reads its writes to the shared catalogs before COMMIT (pg-replay.ts). Only a
 * statement Postgres runs outside a transaction block runs bare, its writes unread: each such kind
 * the replay does not leave out as beyond its database is run here, and none writes a shared
 * catalog. A backend keeps a committed or bare statement's counts in its next read until it flushes
 * them (.tmp/grunt/r21-premise/p1-carry.log), so a read before and after each one counts it. A
 * comment on the scratch database, written first, stays counted only while nothing flushed, so a
 * flush between the reads fails the test instead of reading as no write. The counts are the
 * backend's own: another suite's work on the server never reaches them.
 */
import { beforeAll, describe, expect, it } from "vitest"
import {
	beyondDatabase,
	CONCURRENT,
	nodeOf,
	OUTSIDE,
	outsideOnly,
} from "../../../src/migrate/core/pg-outside-transaction.ts"
import { loadPostgres } from "../../../src/migrate/core/pg-live-objects.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { sharedWrites } from "../../../src/migrate/core/pg-server-writes.ts"
import { pgRead } from "../../../src/migrate/core/pg-split.ts"
import { postgresOptionsOf } from "../../../src/migrate/core/pg-url.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

/* the scratch database's tables, which the bare statements work on */
const SETUP =
	"CREATE TABLE t (a int); CREATE INDEX i ON t (a); CLUSTER t USING i; CREATE TABLE p (a int) PARTITION BY RANGE (a); CREATE TABLE p1 PARTITION OF p FOR VALUES FROM (0) TO (10)"

/* each kind the replay runs bare, DISCARD ALL last: it drops the session's prepared statements */
const BARE = [
	"VACUUM",
	"VACUUM t",
	"CLUSTER",
	"CREATE INDEX CONCURRENTLY j ON t (a)",
	"REINDEX INDEX CONCURRENTLY j",
	"REINDEX TABLE CONCURRENTLY t",
	"DROP INDEX CONCURRENTLY j",
	"ALTER TABLE p DETACH PARTITION p1 CONCURRENTLY",
	"REINDEX SCHEMA public",
	"DISCARD ALL",
]

/* each kind the replay leaves out as beyond its database, so never runs */
const LEFT_OUT = [
	"ALTER DATABASE d SET TABLESPACE pg_default",
	"ALTER SUBSCRIPTION s REFRESH PUBLICATION",
	"ALTER SUBSCRIPTION s SET (failover = true)",
	"ALTER SUBSCRIPTION s ADD PUBLICATION q",
	"ALTER SYSTEM SET work_mem = '4MB'",
	"CREATE SUBSCRIPTION s CONNECTION 'dbname=d' PUBLICATION q",
	"CREATE TABLESPACE ts LOCATION '/nowhere'",
	"CREATE DATABASE d",
	"DROP SUBSCRIPTION s",
	"DROP TABLESPACE ts",
	"DROP DATABASE d",
	"REINDEX DATABASE d",
	"REINDEX SYSTEM d",
	"COMMIT PREPARED 'x'",
	"ROLLBACK PREPARED 'x'",
]

/** A statement's node type and fields */
const parsed = (sql: string) => nodeOf(pgRead(`${sql};\n`).statements[0]?.tree)

describe("the statements a txmode none replay runs bare (P1 of r21)", () => {
	it("names each kind Postgres runs only outside a transaction: run bare, or left out", () => {
		const kinds = [...BARE, ...LEFT_OUT].map((sql) => parsed(sql)[0])
		expect([...new Set(kinds)].sort()).toEqual(
			[...new Set([...Object.keys(OUTSIDE), ...Object.keys(CONCURRENT)])].sort(),
		)
		for (const sql of [...BARE, ...LEFT_OUT]) expect(outsideOnly(...parsed(sql)), sql).toBeDefined()
		for (const sql of BARE) expect(beyondDatabase(...parsed(sql)), sql).toBeUndefined()
		for (const sql of LEFT_OUT) expect(beyondDatabase(...parsed(sql)), sql).toBeDefined()
	})

	it("writes no shared catalog in any it runs bare, as a superuser", async () => {
		await withScratchDb(async (url) => {
			/* the connection the replay opens, through comb's own load */
			const connect = await loadPostgres("the test replays on Postgres")
			const sql = connect({ ...postgresOptionsOf(url, "devUrl"), max: 1, onnotice: () => undefined })
			try {
				await sql.unsafe(SETUP, [])
				const sentinel = `COMMENT ON DATABASE ${new URL(url).pathname.slice(1)} IS 'counted'`
				for (const statement of BARE) {
					/* the counts are the backend's pending ones, which it flushes when idle, at most once a second unless
					   forced: flushed now, none lands before the reads below, and the sentinel shows one that did */
					await sql.unsafe("SELECT pg_stat_force_next_flush()", [])
					await sql.unsafe(sentinel, [])
					const before = await sharedWrites(sql)
					expect(before.get("pg_shdescription"), statement).toBe(1)
					await sql.unsafe(statement, [])
					const after = await sharedWrites(sql)
					expect(after.get("pg_shdescription"), `${statement}: the counts were flushed mid-read`).toBe(1)
					expect(after, statement).toEqual(before)
				}
			} finally {
				await sql.end()
			}
		})
	}, 120_000)
})
