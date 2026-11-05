/**
 * A test run leaves no test role behind (comb-5d, plan 21): testRoles and dropRoles drop each
 * comb_t_* role as its test ends, and a run killed before that left them for a later run to hand-
 * clean. The Postgres projects' global setup sweeps, once it holds the run's lock (pg-run-lock.ts),
 * every comb_t_* role with no pg_shdepend row and no session; any other is kept, and said why.
 * Sibling: the scratch database sweep (scratch-sweep.test.ts).
 */
import pg from "pg"
import { afterAll, describe, expect, it } from "vitest"
import { asRole, dropRoles, query, unique } from "../support/pg-roles.ts"
import { pgUrl } from "../support/pg.ts"
import { sweepTestRoles } from "../support/role-sweep.ts"

/* the roles this file plants, each under a prefix of its own so the sweep it runs reaches no other file's */
const prefix = unique("comb_t_sweep")
const [free, held, busy] = ["free", "held", "busy"].map((what) => `${prefix}_${what}`) as [string, string, string]
afterAll(async () => {
	/* the grant that keeps the sweep off `held` keeps dropRoles off it too */
	if ((await query(pgUrl(), `SELECT 1 FROM pg_roles WHERE rolname = '${held}'`)).length > 0)
		await query(pgUrl(), `REVOKE CONNECT ON DATABASE postgres FROM ${held}`)
	await dropRoles(free, held, busy)
})

describe("a test run leaves no test role behind (sibling: the scratch database sweep)", () => {
	it("drops a comb_t_ role with no dependency and no session, and keeps one with either, saying why", async () => {
		await query(pgUrl(), `CREATE ROLE ${free}`)
		await query(pgUrl(), `CREATE ROLE ${held}`)
		await query(pgUrl(), `GRANT CONNECT ON DATABASE postgres TO ${held}`)
		const session = new pg.Client({ connectionString: await asRole(pgUrl(), busy, "") })
		await session.connect()
		const admin = new pg.Client({ connectionString: pgUrl() })
		await admin.connect()
		try {
			const lines: string[] = []
			const swept = await sweepTestRoles(admin, { like: `${prefix}\\_%`, log: (line) => lines.push(line) })
			expect(swept.dropped).toEqual([free])
			const left = await query(pgUrl(), `SELECT rolname FROM pg_roles WHERE rolname LIKE '${prefix}\\_%' ORDER BY 1`)
			expect(left.map(({ rolname }) => rolname)).toEqual([busy, held])
			expect(lines).toEqual([
				`[comb] role sweep keeps ${busy}: a session runs as it`,
				`[comb] role sweep dropped ${free}, which a killed run left`,
				`[comb] role sweep keeps ${held}: 1 object depends on it (pg_shdepend)`,
			])
		} finally {
			await admin.end()
			await session.end()
		}
	})
})
