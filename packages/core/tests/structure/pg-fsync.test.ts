/**
 * The Postgres projects' global setup warns when the test server runs with fsync on (pg-fsync.ts), the
 * setting that made each DROP DATABASE wait on a checkpoint's fsync and timed migrate-adopt's cases out.
 */
import { describe, expect, it } from "vitest"
import { fsyncWarning } from "../integration/support/pg-fsync.ts"

/** A server whose SHOW fsync answers `fsync` */
const server = (fsync: string) => ({
	query: async () => ({ rows: [{ fsync }] }),
})

describe("the test server's fsync, read as the Postgres suites start", () => {
	it("warns of fsync on, naming the setting that turns it off", async () => {
		expect(await fsyncWarning(server("on"))).toContain("ALTER SYSTEM SET fsync = off; SELECT pg_reload_conf()")
	})

	it("says nothing of fsync off", async () => {
		expect(await fsyncWarning(server("off"))).toBeUndefined()
	})
})
