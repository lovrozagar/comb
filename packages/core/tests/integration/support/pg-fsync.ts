/**
 * The test server runs with fsync off, on CI (ci.yml's step) and here (~/.cache/pg17-embedded/start.mjs),
 * for every DROP DATABASE forces a checkpoint, and each scratch and replay database a suite drops waits
 * on its fsync: with fsync on, migrate-adopt.test.ts spent 37.8 s of its 53.7 s there alone, and a drop
 * waited up to 16.5 s while other runs dropped theirs, which timed its cases out. The Postgres projects'
 * global setup warns when the server has it on (pg-run-lock.ts), so a rebuilt or foreign server cannot
 * bring that back unseen. The test server is throwaway: nothing on it needs to survive a crash.
 */
/** The warning for `admin`'s server when its fsync is on, undefined when it is off */
export async function fsyncWarning(admin: {
	query: (sql: string) => Promise<{ rows: Array<{ fsync?: unknown }> }>
}): Promise<string | undefined> {
	const { rows } = await admin.query("SHOW fsync")
	return rows[0]?.fsync === "off"
		? undefined
		: "[comb] the test server runs with fsync on: each DROP DATABASE waits on a checkpoint's fsync, and the Postgres suites run several times slower; set fsync = off (ALTER SYSTEM SET fsync = off; SELECT pg_reload_conf())"
}
