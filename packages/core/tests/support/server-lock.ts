/**
 * The shared test server's catalogs, read and written under one reader-writer lock (AE6 of r22). A
 * check's replay reads devUrl's server's shared catalogs around every file and bare statement, and
 * takes a change there for the file's when it is to a name the file spells (pg-replay.ts). So a
 * write of another test, in another file, worker or run, that lands inside the replay's reads, to a
 * name the file spells, is refused as the file's: an every-role setting is about `all`, which any
 * file holding `DISCARD ALL`, `GRANT ALL` or `UNION ALL` spells, and probe-settings.test.ts's
 * `ALTER ROLE ALL SET` refused replay-session.test.ts's `DISCARD ALL` file that way.
 *
 * Every test of the Postgres projects holds the lock shared while it runs (server-lock.setup.ts),
 * so no check runs outside it, whoever starts one. A test that writes a shared catalog row to a name
 * another test's file may spell runs that write in `writingServer`, holding the lock alone: the
 * every-role settings of probe-settings.test.ts and bare-replay.test.ts. A role or database named
 * for its test alone (testRoles, unique, withScratchDb) needs no such hold, as no other test's file
 * spells its name, so the replay takes its change for another session's and passes it. The run's
 * global setup resets every-role settings before any test runs (pg-run-lock.ts, then pg-sweeps.ts), so outside this.
 *
 * Each holder takes it on the run's database whatever URL it is given (lockUrl), so the lock is the
 * server's and spans files, workers and runs from other checkouts,
 * and a session's own lock never blocks it: `writingServer` gives up its test's shared hold before
 * it waits alone, so two writers wait in turn, never on each other.
 */
import pg from "pg"
import { pgUrl } from "../integration/support/pg.ts"

/** The lock's key pair, apart from the run's (pg-lock.ts) and stale-replay.ts's */
export const SERVER_KEY = "hashtext('comb test'), hashtext('a server-wide write')"

/** The longest a test waits for the lock: every test running beside it, and a writer queued ahead of it */
export const SERVER_LOCK_WAIT_MS = 10 * 60_000

/**
 * `url` on the run's own database, COMB_TEST_PG_URL's: Postgres keys an advisory lock by the database
 * of the session that takes it, so a hold on a scratch or replay database's session would meet no
 * hold on another's, and the lock is the server's only when every holder takes it on that one
 */
const lockUrl = (url: string): string => {
	const fixed = new URL(url)
	fixed.pathname = new URL(pgUrl()).pathname
	return fixed.toString()
}

/** One holder of the lock on its own session to `url`'s server, on the run's database, named `name` in pg_stat_activity */
export function serverLock(name = "comb test server lock", url = pgUrl()) {
	let session: pg.Client | undefined
	const sessionOf = async (): Promise<pg.Client> => {
		if (session === undefined) {
			session = new pg.Client({ application_name: name, connectionString: lockUrl(url) })
			await session.connect()
		}
		return session
	}
	const reading = async (): Promise<void> => {
		await (await sessionOf()).query(`SELECT pg_advisory_lock_shared(${SERVER_KEY})`)
	}
	const doneReading = async (): Promise<void> => {
		await (await sessionOf()).query(`SELECT pg_advisory_unlock_shared(${SERVER_KEY})`)
	}
	/** `write` run holding the lock alone, the holder's shared hold given up first and taken again after */
	const writing = async <T>(write: () => Promise<T>): Promise<T> => {
		const held = await sessionOf()
		await held.query(`SELECT pg_advisory_unlock_shared(${SERVER_KEY})`)
		await held.query(`SELECT pg_advisory_lock(${SERVER_KEY})`)
		try {
			return await write()
		} finally {
			await held.query(`SELECT pg_advisory_unlock(${SERVER_KEY})`)
			await held.query(`SELECT pg_advisory_lock_shared(${SERVER_KEY})`)
		}
	}
	const end = async (): Promise<void> => {
		await session?.end()
		session = undefined
	}
	return { doneReading, end, reading, writing }
}

/** The lock the running test file holds (server-lock.setup.ts) */
export const fileLock = serverLock()

/** `write`, a write of a shared catalog row to a name another test's file may spell, run holding the server's lock alone */
export const writingServer = <T>(write: () => Promise<T>): Promise<T> => fileLock.writing(write)
