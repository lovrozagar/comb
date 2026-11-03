/**
 * The database the dev replay runs in (P1 ⊃ P2 of r20): made on devUrl's server from template0 for
 * one replay and dropped after it, so the history runs file by file, committed, as Atlas applies it,
 * and nothing devUrl's own database holds changes the verdict. devUrl's installed extensions are
 * copied in first, each in its schema at its version, as Atlas replays in devUrl's database as it
 * is, but for one a replayed file creates, which the file makes where it says (P5 of r21). The
 * roles it makes are pg-replay-roles.ts's.
 *
 * Postgres records no owner for a database or a role a session made, so the database's name and a
 * role's tag carry the backend that made them, its pid and its start (P2 of r21), and a run drops
 * those whose backend is gone: what a killed run left goes on the next run, and a live run's is
 * never touched. Only this role's databases are dropped, none with a session in it, and only tagged
 * roles, none that still owns anything; a drop that fails is left to a later run, and never decides
 * the verdict (P4 of r21). A plain DROP DATABASE waits only for an autovacuum worker, and fails
 * after 5 s with another backend in the database, so a sweep skips one with a session in it, a
 * person's psql among them. 0.19 marked its databases and roles with the run's start alone; those
 * go once they are an hour old.
 */
import { randomUUID } from "node:crypto"
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import type { PgTarget } from "./atlas-target.ts"
import { type Connect, loadPostgres } from "./pg-live-objects.ts"
import { nodeOf } from "./pg-outside-transaction.ts"
import { pgRead } from "./pg-split.ts"
import { postgresOptionsOf } from "./pg-url.ts"

type Sql = ReturnType<Connect>

/* what names a replay's database and tags a role it made, with the backend that made it */
const PREFIX = "comb_replay_"
const TAG = "comb_replay"

/* how old 0.19's database or role, marked with its run's start alone, is before a run counts it leaked */
const STALE_MS: number = 60 * 60_000

/** A Postgres error's SQLSTATE */
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code

const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

/** `step` run, its failure left to the next run's sweep: cleaning up never replaces the replay's verdict */
async function settle(step: () => Promise<unknown>): Promise<void> {
	try {
		await step()
	} catch {
		// reason: a database or role left behind is the next run's sweep's; the verdict is the replay's
	}
}

/**
 * Drop `role`, unless something still depends on it or it is not this role's to drop: a later sweep
 * takes it. Two sessions dropping one role race in Postgres's catalog, and the loser fails without
 * a SQLSTATE of its own (XX000, "could not find tuple for role"), so a role gone after any failure
 * is dropped
 */
async function dropRole(admin: Sql, role: string): Promise<void> {
	try {
		await admin.unsafe(`DROP ROLE IF EXISTS ${sqlIdentifier(role)}`, [])
	} catch (error) {
		// reason: another replay's objects depend on the role, or another role made it: never this run's failure
		if (codeOf(error) === "2BP01" || codeOf(error) === "42501") return
		const [left] = await admin.unsafe("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])
		if (left !== undefined) throw error
	}
}

/* every backend on the server: its pid, the database it is in, and its start in microseconds where this role may read it */
const SESSIONS =
	"SELECT pid, datname, (extract(epoch FROM backend_start) * 1000000)::bigint::text AS start FROM pg_stat_activity"

type Session = Record<string, unknown>

/** The backend `admin` runs on, as a replay's database name and role tag carry it: `<pid>_<start>` */
async function ownerOf(admin: Sql): Promise<string> {
	const [self] = await admin.unsafe(`${SESSIONS} WHERE pid = pg_backend_pid()`, [])
	return `${(self as Session)["pid"]}_${(self as Session)["start"]}`
}

/**
 * Whether the replay `owner` names is over: its backend is gone, where a backend of another role
 * with its pid, whose start this role cannot read, counts as it; under 0.19's mark, the run's start,
 * an hour after it at `now`
 */
function over(owner: string | undefined, sessions: readonly Session[], now: number): boolean {
	if (owner === undefined) return false
	const [pid, start] = owner.split("_")
	if (start === undefined) return now - Number(pid) > STALE_MS
	return !sessions.some((each) => String(each["pid"]) === pid && (each["start"] === null || each["start"] === start))
}

/** Drop the replay databases this role made and the tagged roles whose replay is over at `now`, each drop settled */
async function sweep(admin: Sql, now: number): Promise<void> {
	const sessions = await admin.unsafe(SESSIONS, [])
	const databases = await admin.unsafe(
		`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%' AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
		[],
	)
	for (const { datname } of databases) {
		const name = String(datname)
		const owner = /^comb_replay_(\d+(?:_\d+)?)_[^_]+$/.exec(name)?.[1]
		if (!sessions.some((each) => each["datname"] === name) && over(owner, sessions, now))
			await settle(() => admin.unsafe(`DROP DATABASE IF EXISTS ${sqlIdentifier(name)}`, []))
	}
	const roles = await admin.unsafe(
		`SELECT r.rolname, d.description FROM pg_roles r JOIN pg_shdescription d ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass WHERE d.description LIKE 'comb\\_replay %'`,
		[],
	)
	for (const { description, rolname } of roles) {
		const owner = new RegExp(`^${TAG} (\\d+(?:_\\d+)?)$`).exec(String(description))?.[1]
		if (over(owner, sessions, now)) await settle(() => dropRole(admin, String(rolname)))
	}
}

/* why comb loads postgres.js in an apply */
const SWEEPS = "sweep what a killed check left on a postgres:// devUrl's server"

/**
 * The sweep, run on `target`'s dev server before an apply (P2 of r21): a check killed past its
 * cleanup leaves a role there, which apply's CREATE ROLE of it stops at where dev and target share
 * a server. Housekeeping never stops an apply, so without the postgres package, on Atlas's docker://
 * container or on a devUrl it cannot reach, it sweeps nothing
 */
async function sweepDev(target: PgTarget, load: () => Promise<Connect> = () => loadPostgres(SWEEPS)): Promise<void> {
	if (target.devUrl.startsWith("docker:")) return
	await settle(async () => {
		const admin = (await load())({ ...postgresOptionsOf(target.devUrl, "devUrl"), max: 1, onnotice: () => undefined })
		try {
			await sweep(admin, Date.now())
		} finally {
			await admin.end()
		}
	})
}

/** A new replay database on `admin`'s server, named for its `owner`; a role without CREATEDB is `refused` */
async function makeDatabase(admin: Sql, owner: string, refused: () => Error): Promise<string> {
	const name = `${PREFIX}${owner}_${randomUUID().replaceAll("-", "").slice(0, 8)}`
	try {
		await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0`, [])
	} catch (error) {
		if (codeOf(error) === "42501") throw refused()
		throw error
	}
	return name
}

/* the extensions a database holds, in the order they were made, so one another needs comes first */
const EXTENSIONS =
	"SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY e.oid"

/** The extensions the history `texts` create, which the replay leaves them to make */
const extensionsOf = (texts: readonly string[]): Set<string> =>
	new Set(
		texts.flatMap((text) =>
			pgRead(text).statements.flatMap(({ tree }) => {
				const [type, node] = tree === undefined ? ["", {}] : nodeOf(tree)
				return type === "CreateExtensionStmt" ? [String(node["extname"])] : []
			}),
		),
	)

/**
 * Every extension `from` holds made in `to`, in its schema at its version, but those the history
 * `makes`; one `to` cannot make is `refused`
 */
async function copyExtensions(
	from: Sql,
	to: Sql,
	{ makes, refused }: { makes: ReadonlySet<string>; refused: (name: string, error: unknown) => Error },
): Promise<void> {
	for (const { name, schema, version } of await from.unsafe(EXTENSIONS, [])) {
		if (makes.has(String(name))) continue
		const [extension, home] = [sqlIdentifier(String(name)), sqlIdentifier(String(schema))]
		try {
			if (schema !== "pg_catalog" && schema !== "public") await to.unsafe(`CREATE SCHEMA IF NOT EXISTS ${home}`, [])
			await to.unsafe(
				`CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA ${home} VERSION ${literal(String(version))}`,
				[],
			)
		} catch (error) {
			throw refused(String(name), error)
		}
	}
}

export {
	codeOf,
	copyExtensions,
	dropRole,
	extensionsOf,
	literal,
	makeDatabase,
	ownerOf,
	settle,
	STALE_MS,
	type Sql,
	sweep,
	sweepDev,
	TAG,
}
