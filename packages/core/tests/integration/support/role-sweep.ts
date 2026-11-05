/**
 * The test roles the Postgres suites make on the shared test server, comb_t_* (pg-roles.ts's
 * testRoles and unique), and the sweep of the ones a killed run left: each test drops its own as it
 * ends, which a killed run never reaches. The Postgres projects' global setup sweeps once the run's
 * lock is held (pg-run-lock.ts, then pg-sweeps.ts), when no other run's Postgres suites are running, so none of their
 * roles is in use; a role is still dropped only when nothing depends on it (no pg_shdepend row: no
 * object it owns, no grant to it, in any database) and no session runs as it. Every other is kept
 * and logged with why, and each drop is logged.
 */
import type pg from "pg"

/** One test role as the sweep reads it */
type Seen = { busy: boolean; dependents: number; name: string }

/** Why `role` stays, or undefined when the sweep drops it */
function kept(role: Seen): string | undefined {
	if (role.busy) return "a session runs as it"
	if (role.dependents > 0)
		return `${role.dependents} ${role.dependents === 1 ? "object depends" : "objects depend"} on it (pg_shdepend)`
	return undefined
}

/**
 * Drop each test role a killed run left, those named `like` (comb_t_* by default), on `admin`'s
 * server; keep and log every other. A role that gained a dependent or a session since the read keeps
 * its drop from running, and is kept and logged
 */
export async function sweepTestRoles(
	admin: pg.Client,
	{
		like = "comb\\_t\\_%",
		log = (line: string) => void process.stderr.write(`${line}\n`),
	}: { like?: string | undefined; log?: ((line: string) => void) | undefined } = {},
): Promise<{ dropped: string[] }> {
	const { rows } = await admin.query<Seen>(
		`SELECT r.rolname AS name,
			EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.usesysid = r.oid) AS busy,
			(SELECT count(*) FROM pg_shdepend s WHERE s.refclassid = 'pg_authid'::regclass AND s.refobjid = r.oid)::int AS dependents
		FROM pg_roles r WHERE r.rolname LIKE $1 ORDER BY r.rolname`,
		[like],
	)
	const dropped: string[] = []
	for (const role of rows) {
		const why = kept(role)
		if (why !== undefined) {
			log(`[comb] role sweep keeps ${role.name}: ${why}`)
			continue
		}
		try {
			await admin.query(`DROP ROLE ${admin.escapeIdentifier(role.name)}`)
			dropped.push(role.name)
			log(`[comb] role sweep dropped ${role.name}, which a killed run left`)
		} catch (error) {
			log(`[comb] role sweep keeps ${role.name}: its drop failed, ${(error as Error).message}`)
		}
	}
	return { dropped }
}
