/**
 * The statements Postgres runs only outside a transaction block (P1 of r21): each kind a
 * `-- atlas:txmode none` file holds is run bare, as Atlas sends it, or left out as beyond its
 * database. The replay reads the server's committed shared catalogs around each bare statement (P1
 * and P2 of r22), so each kind it runs is run here between two reads, and none reads as a change
 * past its database: such a statement in a history file never trips the check.
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
import { prepareSnapshot, snapshot, snapshotChanges } from "../../../src/migrate/core/pg-server-snapshot.ts"
import { namesIn } from "../../../src/migrate/core/sql-code.ts"
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

	it("changes no shared catalog row in any it runs bare, read as the replay reads them, as a superuser", async () => {
		await withScratchDb(async (url) => {
			/* the connections the replay opens, through comb's own load: one in the database, one beside it */
			const connect = await loadPostgres("the test replays on Postgres")
			const sql = connect({ ...postgresOptionsOf(url, "devUrl"), max: 1, onnotice: () => undefined })
			const admin = connect({ ...postgresOptionsOf(url, "devUrl"), max: 1, onnotice: () => undefined })
			try {
				await sql.unsafe(SETUP, [])
				await prepareSnapshot(admin, new URL(url).pathname.slice(1))
				for (const statement of BARE) {
					const before = await snapshot(admin)
					await sql.unsafe(statement, [])
					/* other sessions change the server too: the replay reads a change as a statement's by the names it spells */
					expect(snapshotChanges(before, await snapshot(admin), namesIn(statement)), statement).toEqual([])
				}
			} finally {
				await sql.end()
				await admin.end()
			}
		})
	}, 120_000)
})
