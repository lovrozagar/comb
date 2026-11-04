/**
 * One run of the Postgres suites at a time on COMB_TEST_PG_URL (comb-9d, plan 21): the global setup
 * of the Postgres projects (vitest.config.ts) holds the run's lock (tests/support/pg-lock.ts) for the
 * whole run, so two processes running Postgres suites on the shared test server serialize on the
 * server itself, however each was started. heavy.lock stays for the machine's CPU and memory.
 *
 * vitest runs a project's global setup once for each project that has files in the run, both
 * Postgres projects (the UTC one and the one off UTC) in the one main process; each is one holder of
 * the process's one session, ended at the last teardown.
 *
 * The key is apart from stale-replay.ts's, and the two cannot deadlock: a run takes this lock in
 * global setup, before any of its tests, so a run waiting on it holds no stale-replay lock; and the
 * stale-replay locks a holding run's tests wait on are held by its own tests, since no other run's
 * Postgres suites are running.
 *
 * Once it holds the lock, the run sweeps the scratch databases a timed-out or killed run left
 * (scratch-sweep.ts, plan 21 leaf 10.9): no other run's suites are running then, so none of theirs
 * is in use.
 */
import { acquirePgRunLock } from "../../support/pg-lock.ts"
import setupIntegration from "./global-setup.ts"
import { pgUrl } from "./pg.ts"
import { sweepScratchDbs } from "./scratch-sweep.ts"

/** The integration setup, then the run's lock, held until this project tears down, and the scratch swept once it is taken */
export default async function setup(): Promise<() => Promise<void>> {
	setupIntegration()
	return acquirePgRunLock(pgUrl(), { taken: sweepScratchDbs })
}
