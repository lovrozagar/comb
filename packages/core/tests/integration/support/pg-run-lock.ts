/**
 * One run of the Postgres suites at a time on COMB_TEST_PG_URL (comb-9d, plan 21): the global setup
 * of the Postgres projects (vitest.config.ts) holds a session-level advisory lock on a fixed key for
 * the whole run, so two processes running Postgres suites on the shared test server serialize on the
 * server itself, however each was started. heavy.lock stays for the machine's CPU and memory. The
 * lock lives in the URL's database, which every run sharing the URL shares; a run that crashes
 * drops its session, and Postgres frees the lock with it.
 *
 * vitest runs a project's global setup once for each project that has files in the run, both
 * Postgres projects (the UTC one and the one off UTC) in the one main process. A second session
 * asking for the key would wait on the first forever, so the process keeps one session, on
 * globalThis since each project loads this module on its own, and ends it at the last teardown.
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
import pg from "pg"
import setupIntegration from "./global-setup.ts"
import { pgUrl } from "./pg.ts"
import { sweepScratchDbs } from "./scratch-sweep.ts"

/** The lock's key pair: comb's test pair, apart from stale-replay.ts's ('comb test', 'a replay left') */
export const RUN_KEY = "hashtext('comb test'), hashtext('a postgres run')"

type Held = { projects: number; session: Promise<pg.Client> }

const HELD = Symbol.for("comb.test.pg-run-lock")
const store = globalThis as typeof globalThis & { [HELD]?: Held }

/** A session on `url` holding the lock, said once on stderr when another run holds it first, and the scratch swept */
async function take(url: string): Promise<pg.Client> {
	const session = new pg.Client({ connectionString: url, keepAlive: true })
	await session.connect()
	const { rows } = await session.query<{ got: boolean }>(`SELECT pg_try_advisory_lock(${RUN_KEY}) AS got`)
	if (rows[0]?.got !== true) {
		const { host, pathname } = new URL(url)
		process.stderr.write(
			`[comb] waiting for another run's Postgres suites on ${host}${pathname}: advisory lock (${RUN_KEY})\n`,
		)
		await session.query(`SELECT pg_advisory_lock(${RUN_KEY})`)
	}
	await sweepScratchDbs(session)
	return session
}

/** The integration setup, then the run's lock, held until the last Postgres project tears down */
export default async function setup(): Promise<() => Promise<void>> {
	setupIntegration()
	const held = (store[HELD] ??= { projects: 0, session: take(pgUrl()) })
	held.projects += 1
	await held.session
	return async () => {
		held.projects -= 1
		if (held.projects > 0) return
		delete store[HELD]
		await (await held.session).end()
	}
}
