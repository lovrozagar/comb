/**
 * The run's lock on the shared Postgres test server (comb-9d, plan 21): a session-level advisory lock
 * on one fixed key, so no two runs of suites that reach the server overlap on it, however each was
 * started. vitest's Postgres projects take it in their global setup (tests/integration/support/
 * pg-run-lock.ts); a suite that runs apart from them (bun:test, the consumer cells, e2e) takes it in
 * its own setup through acquirePgRunLock and releases it after its last use of the server.
 * tests/structure/pg-projects.test.ts holds every test file that reaches the server to one of the two.
 *
 * One process keeps one session for every holder, on globalThis, since each importer may load this
 * module on its own: a second session asking for the key would wait on the first forever. The last
 * release ends it. A run that crashes drops its session, and Postgres frees the lock with it.
 */
import pg from "pg"

/** The lock's key pair: comb's test pair, apart from stale-replay.ts's ('comb test', 'a replay left') */
export const RUN_KEY = "hashtext('comb test'), hashtext('a postgres run')"

/**
 * How long a suite's hook waits for the lock: past any one run of the Postgres suites, as their global
 * setup, which has no timeout, waits. A hook's own default (bun's 5s, a suite's setup budget) would
 * fail a suite that is only queued behind another run.
 */
export const PG_LOCK_WAIT_MS = 60 * 60_000

type Held = { holders: number; session: Promise<pg.Client> }

const HELD = Symbol.for("comb.test.pg-run-lock")
const store = globalThis as typeof globalThis & { [HELD]?: Held }

/**
 * A session on `url` holding the lock, said once on stderr when another run holds it first, with
 * `taken` run on it once it holds the lock; a session that fails either is ended, freeing the lock
 */
async function take(url: string, taken: ((session: pg.Client) => Promise<unknown>) | undefined): Promise<pg.Client> {
	const session = new pg.Client({ connectionString: url, keepAlive: true })
	await session.connect()
	try {
		const { rows } = await session.query<{ got: boolean }>(`SELECT pg_try_advisory_lock(${RUN_KEY}) AS got`)
		if (rows[0]?.got !== true) {
			const { host, pathname } = new URL(url)
			process.stderr.write(
				`[comb] waiting for another run's Postgres suites on ${host}${pathname}: advisory lock (${RUN_KEY})\n`,
			)
			await session.query(`SELECT pg_advisory_lock(${RUN_KEY})`)
		}
		await taken?.(session)
	} catch (error) {
		await session.end()
		throw error
	}
	return session
}

/**
 * Hold the run's lock on `url`'s server, waiting for any other run that holds it; the release ends
 * the process's session once no holder is left. Each call is one holder, released once. `taken` runs
 * once a process, on the session that takes the lock, before any holder's call returns: the
 * Postgres projects' setup sweeps the scratch a gone run left there.
 */
export async function acquirePgRunLock(
	url: string,
	{ taken }: { taken?: ((session: pg.Client) => Promise<unknown>) | undefined } = {},
): Promise<() => Promise<void>> {
	const held = (store[HELD] ??= { holders: 0, session: take(url, taken) })
	held.holders += 1
	/* a session that never took the lock is no holder's: the next call opens its own */
	await held.session.catch((error: unknown) => {
		if (store[HELD] === held) delete store[HELD]
		throw error
	})
	let released = false
	return async () => {
		if (released) return
		released = true
		held.holders -= 1
		if (held.holders > 0) return
		delete store[HELD]
		await (await held.session).end()
	}
}
