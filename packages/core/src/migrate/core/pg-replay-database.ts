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
 * never touched. A replay's connections carry its owner as their application_name, and on
 * Postgres 14 and later check every second that their client is there, so a run killed past its
 * cleanup leaves no statement running for long, and the sweep ends one that is left before it drops
 * (P4 of r22). Every replay database the sweep's role may drop is dropped, whichever role made it
 * (PR8 of r22b), but one with any other session in it, a person's psql among them, as a plain DROP
 * DATABASE fails after 5 s with another backend in it; and only tagged roles, none that still owns
 * anything. A drop that fails is left to a later run, and never decides the verdict (P4 of r21).
 * 0.19 marked its databases and roles with the run's start alone; those go once they are an hour
 * old.
 */
import { randomUUID } from "node:crypto"
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import type { PgTarget } from "./atlas-target.ts"
import { type Connect, failureOf, loadPostgres } from "./pg-live-objects.ts"
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

/** Drops the replication slot `slot`, if it is still there */
async function dropSlot(admin: Sql, slot: string): Promise<void> {
	await admin.unsafe("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1", [
		slot,
	])
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

/* every backend on the server: its pid, the database it is in, its application_name, and its start in microseconds where this role may read it */
const SESSIONS =
	"SELECT pid, datname, application_name AS app, (extract(epoch FROM backend_start) * 1000000)::bigint::text AS start FROM pg_stat_activity"

type Session = Record<string, unknown>

/* the first Postgres whose backend checks, while a statement runs, that its client is still there */
const CHECKS_CLIENT = 140_000

/**
 * The backend `admin` runs on, as a replay's database name and role tag carry it, `<pid>_<start>`,
 * and the settings a replay connection takes (P4 of r22): that owner as its application_name, by
 * which the sweep finds a killed replay's backends, and on Postgres 14 and later a check every
 * second that its client is there, by which Postgres ends their statement itself; `admin` takes them
 * too
 */
async function claim(admin: Sql): Promise<{ owner: string; settings: Record<string, string> }> {
	const [self] = await admin.unsafe(
		`${SESSIONS.replace(" FROM pg_stat_activity", ", current_setting('server_version_num')::int AS version FROM pg_stat_activity")} WHERE pid = pg_backend_pid()`,
		[],
	)
	const owner = `${(self as Session)["pid"]}_${(self as Session)["start"]}`
	const settings: Record<string, string> = {
		application_name: `${TAG} ${owner}`,
		...(Number((self as Session)["version"]) >= CHECKS_CLIENT ? { client_connection_check_interval: "1s" } : {}),
	}
	const names = Object.keys(settings)
	await admin.unsafe(
		`SELECT ${names.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, false)`).join(", ")}`,
		names.flatMap((name) => [name, settings[name] as string]),
	)
	return { owner, settings }
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

/** What a replay whose run is over left: its databases, each with the backends it left in it, and its tagged roles */
type Leftovers = { databases: Array<{ name: string; pids: unknown[] }>; roles: string[] }

/**
 * What replays over at `now` left on `sql`'s server, which a sweep takes: the replay databases of
 * any role, or only those `sql`'s role may drop (`droppable`), but one with a session in it other
 * than the backends its own replay left (P4 of r22), and the tagged roles
 */
async function leftovers(sql: Sql, now: number, droppable: boolean): Promise<Leftovers> {
	const sessions = await sql.unsafe(SESSIONS, [])
	const names = await sql.unsafe(
		`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%'${droppable ? " AND pg_has_role(datdba, 'USAGE')" : ""}`,
		[],
	)
	const databases: Leftovers["databases"] = []
	for (const { datname } of names) {
		const name = String(datname)
		const owner = /^comb_replay_(\d+(?:_\d+)?)_[^_]+$/.exec(name)?.[1]
		const inIt = sessions.filter((each) => each["datname"] === name)
		if (over(owner, sessions, now) && inIt.every((each) => each["app"] === `${TAG} ${owner}`))
			databases.push({ name, pids: inIt.map((each) => each["pid"]) })
	}
	const tagged = await sql.unsafe(
		`SELECT r.rolname, d.description FROM pg_roles r JOIN pg_shdescription d ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass WHERE d.description LIKE 'comb\\_replay %'`,
		[],
	)
	const roles = tagged
		.filter(({ description }) =>
			over(new RegExp(`^${TAG} (\\d+(?:_\\d+)?)$`).exec(String(description))?.[1], sessions, now),
		)
		.map(({ rolname }) => String(rolname))
	return { databases, roles }
}

/**
 * Drop what replays over at `now` left, each drop settled: every replay database this role may
 * drop, whichever role made it (PR8 of r22b), once the backends its replay left in it are ended (P4
 * of r22), and the tagged roles
 */
async function sweep(admin: Sql, now: number): Promise<void> {
	const { databases, roles } = await leftovers(admin, now, true)
	for (const { name, pids } of databases) {
		for (const pid of pids) await settle(() => admin.unsafe("SELECT pg_terminate_backend($1)", [pid]))
		await settle(() => admin.unsafe(`DROP DATABASE IF EXISTS ${sqlIdentifier(name)}`, []))
	}
	for (const role of roles) await settle(() => dropRole(admin, role))
}

/* why comb loads postgres.js in an apply */
const SWEEPS = "sweep what a killed check left on a postgres:// devUrl's server"

/* how long apply waits to reach devUrl's server for its sweep, in seconds, where the URL sets no connect_timeout */
const SWEEP_TIMEOUT = 5

/**
 * The sweep, run on `target`'s dev server before an apply (P2 of r21): a check killed past its
 * cleanup leaves a role there, which apply's CREATE ROLE of it stops at where dev and target share
 * a server. Only that server matters, so apply asks the target's own server first, which it reaches
 * anyway, and connects to devUrl only when the target's holds what a sweep would take, waiting
 * SWEEP_TIMEOUT for it (PR7 of r22b). Housekeeping never stops an apply, so without the postgres
 * package, on Atlas's docker:// container or with nothing left it sweeps nothing, and a sweep that
 * fails is `print`ed and passed
 */
async function sweepDev(
	target: PgTarget,
	print: (line: string) => void,
	load: () => Promise<Connect> = () => loadPostgres(SWEEPS),
): Promise<void> {
	if (target.devUrl.startsWith("docker:")) return
	await settle(async () => {
		const connect = await load()
		const server = connect({ ...postgresOptionsOf(target.url, "url"), max: 1, onnotice: () => undefined })
		try {
			const { databases, roles } = await leftovers(server, Date.now(), false)
			if (databases.length + roles.length === 0) return
		} finally {
			await server.end()
		}
		const options = postgresOptionsOf(target.devUrl, "devUrl")
		const admin = connect({
			connect_timeout: SWEEP_TIMEOUT,
			...options,
			max: 1,
			onnotice: () => undefined,
		})
		try {
			await sweep(admin, Date.now())
		} catch (error) {
			// reason: housekeeping never stops an apply; what it left is said, and the next run that reaches devUrl sweeps it
			print(
				`Apply did not sweep what a killed check left on the target's server, as devUrl's server did not answer: ${failureOf(error, { field: "devUrl", url: target.devUrl, urls: [target.devUrl, target.url] })}; a CREATE ROLE of a role it left stops apply until a check or apply that reaches devUrl sweeps it`,
			)
		} finally {
			await admin.end()
		}
	})
}

/** devUrl's options for one replay connection, notices unread; with `at`, the replay's own to its database, with its settings */
function replayOptions(
	devUrl: string,
	at?: { database: string; settings: Record<string, string> },
): Record<string, unknown> {
	const options: Record<string, unknown> = { ...postgresOptionsOf(devUrl, "devUrl"), max: 1, onnotice: () => undefined }
	if (at === undefined) return options
	const connection = { ...(options["connection"] as object | undefined), ...at.settings }
	return { ...options, connection, database: at.database }
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
	dropSlot,
	extensionsOf,
	literal,
	makeDatabase,
	claim,
	replayOptions,
	settle,
	STALE_MS,
	type Sql,
	sweep,
	sweepDev,
	TAG,
}
