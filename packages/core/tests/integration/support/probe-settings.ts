/**
 * The every-role settings the replay suites make on the shared test server, `comb_t.*` placeholders
 * set by ALTER ROLE ALL SET (bare-replay.test.ts, AE6 of r22), reset as their test ends. A run killed
 * before that leaves the setting on every new session of the server, so the Postgres projects' global
 * setup resets each one left once the run's lock is held (pg-run-lock.ts, then pg-sweeps.ts), when no other run's
 * Postgres suites are running. Each statement is logged.
 */
import type pg from "pg"

/** Reset every `comb_t.*` setting for every role in every database on `admin`'s server, each logged */
export async function resetProbeSettings(
	admin: pg.Client,
	{ log = (line: string) => void process.stderr.write(`${line}\n`) }: { log?: (line: string) => void } = {},
): Promise<{ reset: string[] }> {
	const { rows } = await admin.query<{ name: string }>(
		`SELECT DISTINCT split_part(c, '=', 1) AS name FROM pg_db_role_setting, unnest(setconfig) AS c
		WHERE setrole = 0 AND setdatabase = 0 AND c LIKE 'comb\\_t.%' ORDER BY 1`,
	)
	const reset = rows.map(({ name }) => name)
	for (const name of reset) {
		const statement = `ALTER ROLE ALL RESET ${name
			.split(".")
			.map((part) => admin.escapeIdentifier(part))
			.join(".")}`
		log(`[comb] probe settings: ${statement}, which a killed run left`)
		await admin.query(statement)
	}
	return { reset }
}
