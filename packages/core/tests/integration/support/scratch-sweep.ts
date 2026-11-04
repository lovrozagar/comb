/**
 * The scratch databases withScratchDb makes on the shared test server (pg.ts), and the sweep of the
 * ones a timed-out or killed run left (plan 21 leaf 10.9). Each name carries the millisecond it was
 * made, so a later run reads its age from the name; one without it, made before the stamp, is aged by
 * its directory's mtime, which only a role allowed pg_stat_file can read. The Postgres projects'
 * global setup sweeps once the run's lock is held (pg-run-lock.ts), when no other run's Postgres
 * suites are running, so none of their databases is in use; a database is still dropped only when
 * this role owns it, no session is on it and it is over an hour old, and without FORCE, so a session
 * that connects first keeps it. Every other is kept and logged with why.
 */
import { randomUUID } from "node:crypto"
import type pg from "pg"

export const SCRATCH_PREFIX = "comb_scratch_"

/** How old a scratch database is before a later run reads it as one a killed run left: no test holds one this long */
export const SCRATCH_STALE_MS: number = 60 * 60_000

/* the stamp: the millisecond the database was made, then a random part; 59 bytes, within NAMEDATALEN */
const STAMPED = /^comb_scratch_(\d{13})_[0-9a-f]{32}$/

/** A new scratch database's name, stamped with `madeAt` */
export const scratchName = (madeAt: number = Date.now()): string =>
	`${SCRATCH_PREFIX}${madeAt}_${randomUUID().replaceAll("-", "")}`

/** One scratch database as the sweep reads it */
type Seen = { busy: boolean; mtime: number | null; name: string; ours: boolean }

/** Why `db` stays, or undefined when the sweep drops it */
function kept(db: Seen, now: number): string | undefined {
	if (!db.ours) return "another role owns it"
	if (db.busy) return "a session is on it"
	const madeAt = STAMPED.exec(db.name)?.[1]
	const age = madeAt === undefined ? (db.mtime === null ? undefined : now - db.mtime) : now - Number(madeAt)
	if (age === undefined) return "its age is unknown: no stamp in its name, and its directory's mtime is unreadable"
	return age > SCRATCH_STALE_MS ? undefined : "under an hour old"
}

/** Each scratch database on the server, the directory mtime read only where the role may (pg_stat_file) */
async function seen(admin: pg.Client): Promise<Seen[]> {
	const { rows } = await admin.query<{ busy: boolean; name: string; oid: string; ours: boolean }>(
		`SELECT d.oid::text AS oid, d.datname AS name, pg_get_userbyid(d.datdba) = current_user AS ours,
			EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datid = d.oid) AS busy
		FROM pg_database d WHERE d.datname LIKE 'comb\\_scratch\\_%' ORDER BY d.datname`,
	)
	const mtimes = new Map<string, number>()
	const unstamped = rows.filter((row) => !STAMPED.test(row.name)).map((row) => row.oid)
	if (unstamped.length > 0) {
		try {
			const read = await admin.query<{ ms: string | null; oid: string }>(
				`SELECT oid, (extract(epoch FROM (pg_stat_file('base/' || oid, true)).modification) * 1000)::bigint::text AS ms
				FROM unnest($1::oid[]) AS oid`,
				[unstamped],
			)
			for (const { ms, oid } of read.rows) if (ms !== null) mtimes.set(String(oid), Number(ms))
		} catch {
			// reason: a role without pg_stat_file reads no mtime; each unstamped database is kept as of unknown age
		}
	}
	return rows.map(({ busy, name, oid, ours }) => ({ busy, mtime: mtimes.get(oid) ?? null, name, ours }))
}

/**
 * Drop each scratch database a killed run left, on `admin`'s server; keep and log every other. The
 * drop has no FORCE: a session that connected since the read keeps its database
 */
export async function sweepScratchDbs(
	admin: pg.Client,
	{
		log = (line: string) => void process.stderr.write(`${line}\n`),
		now = Date.now(),
	}: { log?: ((line: string) => void) | undefined; now?: number | undefined } = {},
): Promise<{ dropped: string[] }> {
	const dropped: string[] = []
	for (const db of await seen(admin)) {
		const why = kept(db, now)
		if (why !== undefined) {
			log(`[comb] scratch sweep keeps ${db.name}: ${why}`)
			continue
		}
		try {
			await admin.query(`DROP DATABASE ${admin.escapeIdentifier(db.name)}`)
			dropped.push(db.name)
		} catch (error) {
			log(`[comb] scratch sweep keeps ${db.name}: its drop failed, ${(error as Error).message}`)
		}
	}
	if (dropped.length > 0) log(`[comb] scratch sweep dropped ${dropped.length} scratch databases a killed run left`)
	return { dropped }
}
