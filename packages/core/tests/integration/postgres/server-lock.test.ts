/**
 * AE6 of r22's leftover: another test's every-role setting, which is about `all`, landed inside a
 * check's replay of a file that spells ALL, and the check refused it as the file's
 * (replay-session.test.ts's DISCARD ALL beside probe-settings.test.ts). Every test holds the server's
 * lock shared and a server-wide write waits alone (tests/support/server-lock.ts), so the write
 * lands after the check. Sibling: AE6's own role landing, inside the file on a signal
 * (bare-replay.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest"
import { pgCheck, T } from "../support/pg-check.ts"
import { pgUrl, withScratchDb } from "../support/pg.ts"
import { query } from "../support/pg-roles.ts"
import { fileLock, serverLock } from "../../support/server-lock.ts"

const { checked } = pgCheck()

/* the other test file's hold on the lock, on a session of its own, named so the file can wait for it */
const OTHER = "comb test another file"
const other = serverLock(OTHER)
afterEach(other.end)

const logCatalog = (statement: string): void => void process.stderr.write(`[comb] AE6 catalog: ${statement}\n`)

/*
 * the file spells ALL and then waits until the other file's write waits for the lock or has landed, so
 * the write meets the replay's reads whatever the load: with no lock it lands between them
 */
const FILE = `-- atlas:txmode none\n\n-- comb:allow-unsafe: the test's session\nDISCARD ALL;\n-- comb:allow-unsafe: the test's wait\nDO $$ BEGIN WHILE NOT EXISTS (SELECT FROM pg_stat_activity WHERE application_name = '${OTHER}' AND wait_event = 'advisory') AND NOT EXISTS (SELECT FROM pg_db_role_setting, unnest(setconfig) AS c WHERE setrole = 0 AND setdatabase = 0 AND c LIKE 'comb\\_t.probe=%') LOOP PERFORM pg_sleep(0.02); END LOOP; END $$;\n`

/* the replay running the file's wait */
const WAITING = `SELECT 1 FROM pg_stat_activity WHERE query LIKE 'DO $$ BEGIN WHILE NOT EXISTS (SELECT FROM pg_stat_activity WHERE application_name = ''${OTHER}''%' AND datname LIKE 'comb\\_replay\\_%'`

describe("the shared test server's lock (AE6 of r22's leftover)", () => {
	it("holds another file's every-role setting until a check of a file that spells ALL ends", async () => {
		await other.reading()
		const check = checked(T, FILE)
		/* the other file asks for the lock once the replay runs the file's wait, inside the replay's reads */
		while ((await query(pgUrl(), WAITING)).length === 0) await new Promise((tick) => setTimeout(tick, 25))
		const write = other.writing(async () => {
			try {
				logCatalog("ALTER ROLE ALL SET comb_t.probe = 'leaked', another file's write")
				await query(pgUrl(), "ALTER ROLE ALL SET comb_t.probe = 'leaked'")
				return await check
			} finally {
				logCatalog("ALTER ROLE ALL RESET comb_t.probe")
				await query(pgUrl(), "ALTER ROLE ALL RESET comb_t.probe")
			}
		})
		const { refused } = await check
		/* this test's check has ended, so its hold goes, and the write waiting for it lands */
		await fileLock.doneReading()
		await write
		await fileLock.reading()
		expect(refused).toBeUndefined()
	}, 60_000)

	/*
	 * Postgres keys an advisory lock by the database of the session that takes it, so a hold taken on
	 * a scratch database's connection would never meet one on the run's database: the lock is the
	 * server's only when every holder takes it on one database, COMB_TEST_PG_URL's
	 */
	it("holds against a writer on the run's database when taken from a scratch database's URL", async () => {
		const [SCRATCH, WRITER] = ["comb test a scratch holder", "comb test a main writer"]
		await withScratchDb(async (url) => {
			const scratch = serverLock(SCRATCH, url)
			const writer = serverLock(WRITER)
			/* this test's own hold goes, so the writer waits only on others' */
			await fileLock.doneReading()
			try {
				await scratch.reading()
				const write = writer.writing(async () => undefined)
				const blocked = `SELECT 1 FROM pg_stat_activity w, pg_stat_activity h WHERE w.application_name = '${WRITER}' AND h.application_name = '${SCRATCH}' AND h.pid = ANY (pg_blocking_pids(w.pid))`
				const until = Date.now() + 10_000
				let held = false
				while (!held && Date.now() < until) {
					held = (await query(pgUrl(), blocked)).length > 0
					if (!held) await new Promise((tick) => setTimeout(tick, 25))
				}
				await scratch.end()
				await write
				expect(held).toBe(true)
			} finally {
				await scratch.end()
				await writer.end()
				await fileLock.reading()
			}
		})
	}, 60_000)
})
