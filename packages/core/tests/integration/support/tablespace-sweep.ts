/**
 * The tablespaces the replay suites make on the shared test server, `comb_t_*` ones in place
 * (replay-left-out.test.ts, PR5 of r22b), dropped as their test ends. A run killed before that leaves
 * the tablespace on the server, so the Postgres projects' global setup drops each one left once the
 * run's lock is held (pg-run-lock.ts), when no other run's Postgres suites are running. A tablespace
 * that still holds a relation, which Postgres refuses to drop (55000), is kept and said. Each is logged.
 */
import type pg from "pg"

/** Drop every `comb_t_*` tablespace on `admin`'s server that holds nothing, each logged; one that holds a relation is kept */
export async function sweepTablespaces(
	admin: pg.Client,
	{ log = (line: string) => void process.stderr.write(`${line}\n`) }: { log?: (line: string) => void } = {},
): Promise<{ dropped: string[]; kept: string[] }> {
	const { rows } = await admin.query<{ name: string }>(
		"SELECT spcname AS name FROM pg_tablespace WHERE spcname LIKE 'comb\\_t\\_%' ORDER BY 1",
	)
	const dropped: string[] = []
	const kept: string[] = []
	for (const { name } of rows) {
		const statement = `DROP TABLESPACE ${admin.escapeIdentifier(name)}`
		try {
			await admin.query(statement)
			dropped.push(name)
			log(`[comb] tablespace sweep: ${statement}, which a killed run left`)
		} catch (error) {
			if ((error as { code?: unknown }).code !== "55000") throw error
			kept.push(name)
			log(`[comb] tablespace sweep keeps ${name}: ${(error as Error).message}`)
		}
	}
	return { dropped, kept }
}
