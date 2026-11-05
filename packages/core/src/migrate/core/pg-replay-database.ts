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
 * anything. A drop that fails never decides the verdict (P4 of r21), and is said, never left unsaid:
 * what it left, dev's error, and whether a later run's sweep takes it.
 * 0.19 marked its databases and roles with the run's start alone; those go once they are an hour
 * old.
 */
import { randomUUID } from "node:crypto"
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import type { Connect } from "./pg-live-objects.ts"
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
 * too. Its server's version comes with them
 */
async function claim(admin: Sql): Promise<{ owner: string; settings: Record<string, string>; version: number }> {
	const [self] = await admin.unsafe(
		`${SESSIONS.replace(" FROM pg_stat_activity", ", current_setting('server_version_num')::int AS version FROM pg_stat_activity")} WHERE pid = pg_backend_pid()`,
		[],
	)
	const owner = `${(self as Session)["pid"]}_${(self as Session)["start"]}`
	const version = Number((self as Session)["version"])
	const settings: Record<string, string> = {
		application_name: `${TAG} ${owner}`,
		...(version >= CHECKS_CLIENT ? { client_connection_check_interval: "1s" } : {}),
	}
	const names = Object.keys(settings)
	await admin.unsafe(
		`SELECT ${names.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, false)`).join(", ")}`,
		names.flatMap((name) => [name, settings[name] as string]),
	)
	return { owner, settings, version }
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

/**
 * What a replay whose run is over left: its databases, each with the backends it left in it and
 * whether it is a template, and its tagged roles
 */
type Leftovers = { databases: Array<{ name: string; pids: unknown[]; template: boolean }>; roles: string[] }

/**
 * What replays over at `now` left on `sql`'s server, which a sweep takes: the replay databases of
 * any role, or only those `sql`'s role may drop (`droppable`), but one with a session in it other
 * than the backends its own replay left (P4 of r22), and the tagged roles
 */
async function leftovers(sql: Sql, now: number, droppable: boolean): Promise<Leftovers> {
	const sessions = await sql.unsafe(SESSIONS, [])
	const names = await sql.unsafe(
		`SELECT datname, datistemplate FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%'${droppable ? " AND pg_has_role(datdba, 'USAGE')" : ""}`,
		[],
	)
	const databases: Leftovers["databases"] = []
	for (const { datistemplate, datname } of names) {
		const name = String(datname)
		const owner = /^comb_replay_(\d+(?:_\d+)?)_[^_]+$/.exec(name)?.[1]
		const inIt = sessions.filter((each) => each["datname"] === name)
		if (over(owner, sessions, now) && inIt.every((each) => each["app"] === `${TAG} ${owner}`))
			databases.push({ name, pids: inIt.map((each) => each["pid"]), template: datistemplate === true })
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

/**
 * A new replay database on `admin`'s server, named for its `owner`, made from template0 at the
 * target's `locale` (CREATE DATABASE's options for it); a role without CREATEDB is `denied`, and any
 * other refusal, a locale the server lacks among them, `unmade`
 */
async function makeDatabase(
	admin: Sql,
	owner: string,
	{ denied, locale, unmade }: { denied: () => Error; locale: string; unmade: (error: unknown) => Error },
): Promise<string> {
	const name = `${PREFIX}${owner}_${randomUUID().replaceAll("-", "").slice(0, 8)}`
	try {
		await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE template0 ${locale}`, [])
	} catch (error) {
		throw codeOf(error) === "42501" ? denied() : unmade(error)
	}
	return name
}

/*
 * the extensions a database holds, in the order they were made, so one another needs comes first,
 * each with the extensions its version requires
 */
const EXTENSIONS =
	"SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version, coalesce(v.requires, '{}')::text[] AS requires FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace LEFT JOIN pg_available_extension_versions v ON v.name = e.extname AND v.version = e.extversion ORDER BY e.oid"

/**
 * The extensions the history `texts` create with a plain CREATE EXTENSION, the one statement that
 * needs its extension absent, which the replay leaves them to make (P5 of r21); one a file creates IF
 * NOT EXISTS is copied, as a platform installs it on the target (PR1 of r22b)
 */
const extensionsOf = (texts: readonly string[]): Set<string> =>
	new Set(
		texts.flatMap((text) =>
			pgRead(text).statements.flatMap(({ tree }) => {
				const [type, node] = tree === undefined ? ["", {}] : nodeOf(tree)
				return type === "CreateExtensionStmt" && node["if_not_exists"] !== true ? [String(node["extname"])] : []
			}),
		),
	)

/** An extension of devUrl's database, as the replay makes it */
type Extension = { name: string; requires: string[]; schema: string; version: string }

/** `extension` made in `to`, in its schema at its version, or `refused` */
async function makeExtension(
	to: Sql,
	{ name, schema, version }: Extension,
	refused: (name: string, error: unknown) => Error,
): Promise<void> {
	const [extension, home] = [sqlIdentifier(name), sqlIdentifier(schema)]
	try {
		if (schema !== "pg_catalog" && schema !== "public") await to.unsafe(`CREATE SCHEMA IF NOT EXISTS ${home}`, [])
		await to.unsafe(`CREATE EXTENSION IF NOT EXISTS ${extension} WITH SCHEMA ${home} VERSION ${literal(version)}`, [])
	} catch (error) {
		throw refused(name, error)
	}
}

/**
 * Every extension `from` holds made in `to`, in its schema at its version, but those the history
 * `makes`; one `to` cannot make is `refused`. One that requires an extension the history makes waits
 * for it (PR1 of r22b): what is returned makes, in a later session, each waiting extension whose every
 * requirement that session's database now holds, so the replay calls it after each CREATE EXTENSION
 */
async function copyExtensions(
	from: Sql,
	to: Sql,
	{ makes, refused }: { makes: ReadonlySet<string>; refused: (name: string, error: unknown) => Error },
): Promise<(to: Sql) => Promise<void>> {
	let waiting: Extension[] = []
	for (const row of await from.unsafe(EXTENSIONS, [])) {
		const extension: Extension = {
			name: String(row["name"]),
			requires: row["requires"] as string[],
			schema: String(row["schema"]),
			version: String(row["version"]),
		}
		if (makes.has(extension.name)) continue
		if (extension.requires.some((name) => makes.has(name) || waiting.some((each) => each.name === name)))
			waiting.push(extension)
		else await makeExtension(to, extension, refused)
	}
	return async (sql) => {
		if (waiting.length === 0) return
		const held = new Set(
			(await sql.unsafe("SELECT extname FROM pg_extension", [])).map((row) => String(row["extname"])),
		)
		const left: Extension[] = []
		/* in the order they were made, so one waiting on another follows it */
		for (const extension of waiting) {
			if (!extension.requires.every((name) => held.has(name))) {
				left.push(extension)
				continue
			}
			await makeExtension(sql, extension, refused)
			held.add(extension.name)
		}
		waiting = left
	}
}

export {
	claim,
	codeOf,
	copyExtensions,
	extensionsOf,
	leftovers,
	literal,
	makeDatabase,
	replayOptions,
	type Sql,
	STALE_MS,
	TAG,
}
