/**
 * The database the dev replay runs in (P1 ⊃ P2 of r20): made on devUrl's server from template0 for
 * one replay and dropped after it, so the history runs file by file, committed, as Atlas applies it,
 * and nothing devUrl's own database holds changes the verdict. devUrl's installed extensions are
 * copied in first, each in its schema at its version, as Atlas replays in devUrl's database as it
 * is. A role is the server's, not the database's: a CREATE ROLE of one that exists uses it, held by
 * a grant on the replay's database so another replay cannot drop it meanwhile, and one comb creates
 * is tagged and dropped after. Postgres records no creation time for a database or a role, so the
 * database's name and the role's tag carry it, and a run drops those a killed run left once they
 * are an hour old: only this role's databases, only tagged roles, and none that still owns anything.
 * A database is dropped without FORCE, which a role other than a superuser cannot use while any
 * superuser's backend, an autovacuum worker's among them, is in it; a plain drop waits for those.
 */
import { randomUUID } from "node:crypto"
import { sqlIdentifier } from "../../codegen/utils/case.ts"
import type { Connect } from "./pg-live-objects.ts"

type Sql = ReturnType<Connect>

/* what names a replay's database and tags a role it made, with the run's start in epoch milliseconds */
const PREFIX = "comb_replay_"
const TAG = "comb_replay"

/* how old a database or a role a replay made is before another run counts it leaked */
const STALE_MS: number = 60 * 60_000

/** A Postgres error's SQLSTATE */
const codeOf = (error: unknown): unknown => (error as { code?: unknown }).code

const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`

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

/** Drop the replay databases this role made and the tagged roles a killed run left, each over an hour old at `now` */
async function sweep(admin: Sql, now: number): Promise<void> {
	const stale = (ms: string | undefined) => ms !== undefined && now - Number(ms) > STALE_MS
	const databases = await admin.unsafe(
		`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%' AND datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)`,
		[],
	)
	for (const { datname } of databases) {
		if (stale(/^comb_replay_(\d+)_/.exec(String(datname))?.[1]))
			await admin.unsafe(`DROP DATABASE IF EXISTS ${sqlIdentifier(String(datname))}`, [])
	}
	const roles = await admin.unsafe(
		`SELECT r.rolname, d.description FROM pg_roles r JOIN pg_shdescription d ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass WHERE d.description LIKE 'comb\\_replay %'`,
		[],
	)
	for (const { description, rolname } of roles) {
		if (stale(new RegExp(`^${TAG} (\\d+)$`).exec(String(description))?.[1])) await dropRole(admin, String(rolname))
	}
}

/** A new replay database on `admin`'s server, named for `started`; a role without CREATEDB is `refused` */
async function makeDatabase(admin: Sql, started: number, refused: () => Error): Promise<string> {
	const name = `${PREFIX}${started}_${randomUUID().replaceAll("-", "").slice(0, 8)}`
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

/** Every extension `from` holds made in `to`, in its schema at its version; one `to` cannot make is `refused` */
async function copyExtensions(from: Sql, to: Sql, refused: (name: string, error: unknown) => Error): Promise<void> {
	for (const { name, schema, version } of await from.unsafe(EXTENSIONS, [])) {
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

/**
 * A history's CREATE ROLE `sent` of `role`, run in the replay's `database`: an existing role is used,
 * any other made by `sent` and tagged, and either held by a grant on `database`; whether the role
 * is a replay's, which the replay then drops, so whichever of two replays using one role ends last
 * drops it. Within a file's
 * transaction each try is a savepoint, so a role another replay made or dropped since the read is
 * read again
 */
async function createRole(
	sql: Sql,
	{
		database,
		inFile,
		role,
		sent,
		started,
	}: { database: string; inFile: boolean; role: string; sent: string; started: number },
): Promise<boolean> {
	const mark = async (query: string) => {
		if (inFile) await sql.unsafe(query, [])
	}
	for (;;) {
		const [found] = await sql.unsafe(
			"SELECT d.description FROM pg_roles r LEFT JOIN pg_shdescription d ON d.objoid = r.oid AND d.classoid = 'pg_authid'::regclass WHERE r.rolname = $1",
			[role],
		)
		const exists = found !== undefined
		await mark("SAVEPOINT comb_role")
		try {
			if (!exists) {
				await sql.unsafe(sent, [])
				await sql.unsafe(`COMMENT ON ROLE ${sqlIdentifier(role)} IS ${literal(`${TAG} ${started}`)}`, [])
			}
			/* the replay that made the role holds it too, so whichever replay using it ends last drops it */
			await sql.unsafe(`GRANT CONNECT ON DATABASE ${database} TO ${sqlIdentifier(role)}`, [])
			await mark("RELEASE SAVEPOINT comb_role")
			return !exists || String(found["description"]).startsWith(`${TAG} `)
		} catch (error) {
			const raced = exists ? codeOf(error) === "42704" : codeOf(error) === "42710" || codeOf(error) === "23505"
			if (!raced) throw error
			// reason: another replay dropped the role, or made it, since the read: read it again
			await mark("ROLLBACK TO SAVEPOINT comb_role")
		}
	}
}

export { copyExtensions, createRole, dropRole, makeDatabase, STALE_MS, sweep, type Sql }
