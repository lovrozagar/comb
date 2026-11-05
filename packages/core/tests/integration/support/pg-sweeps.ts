/**
 * What a timed-out or killed run left on the shared Postgres test server, swept once a process
 * (comb-9d, plan 21): the Postgres projects' second global setup (vitest.config.ts), after the run's
 * lock (pg-run-lock.ts), so no other run's suites are running and none of what they left is in use.
 * It sweeps the scratch databases (scratch-sweep.ts, plan 21 leaf 10.9), resets each every-role
 * `comb_t.*` setting (probe-settings.ts), drops each `comb_t_*` tablespace that holds nothing
 * (tablespace-sweep.ts), then each `comb_t_*` test role with nothing depending on it and no session
 * on it (role-sweep.ts): after the tablespaces, since a role that owns one is held by it until it is
 * dropped. And it warns when the server runs with fsync on (pg-fsync.ts).
 *
 * It is a setup of its own, apart from the lock's, because what it sweeps is the server's while the
 * lock is a database's: Postgres keys an advisory lock by database, and run-lock.test.ts runs the
 * lock's setup in child processes on a scratch database, beside this run's tests, which a sweep there
 * would reach (their idle comb_t_* roles dropped mid-test). vitest runs it once for each Postgres
 * project in the run, in the one main process, so every call waits on the process's one sweep: no
 * project's tests start before it ends, and none runs beside a second.
 */
import pg from "pg"
import { pgUrl } from "./pg.ts"
import { fsyncWarning } from "./pg-fsync.ts"
import { resetProbeSettings } from "./probe-settings.ts"
import { sweepTestRoles } from "./role-sweep.ts"
import { sweepScratchDbs } from "./scratch-sweep.ts"
import { sweepTablespaces } from "./tablespace-sweep.ts"

const SWEPT = Symbol.for("comb.test.pg-sweeps")
const store = globalThis as typeof globalThis & { [SWEPT]?: Promise<void> }

/** The sweeps, on a session of their own */
async function sweep(): Promise<void> {
	const session = new pg.Client({ connectionString: pgUrl() })
	await session.connect()
	try {
		await sweepScratchDbs(session)
		await resetProbeSettings(session)
		await sweepTablespaces(session)
		await sweepTestRoles(session)
		const warning = await fsyncWarning(session)
		if (warning !== undefined) process.stderr.write(`${warning}\n`)
	} finally {
		await session.end()
	}
}

/** The process's one sweep, run by its first call and waited on by every call */
export default async function setup(): Promise<void> {
	await (store[SWEPT] ??= sweep())
}
