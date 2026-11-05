/**
 * Roles on the test server, for the replay suites: a name no other run holds, a devUrl reached as a
 * role of its own, a role's row and comment as the server holds them. And P1 of r21's shapes: a
 * history file whose change past its database hides inside a statement the replay cannot leave
 * out, so only Postgres can say what it wrote.
 */
import { randomBytes } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, onTestFinished } from "vitest"
import { pgUrl } from "./pg.ts"

/** The rows `sql` returns on the database at `url` */
export async function query(url: string, sql: string): Promise<Array<Record<string, unknown>>> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows as Array<Record<string, unknown>>
	} finally {
		await client.end()
	}
}

/** A name no other test or run holds */
export const unique = (prefix: string): string => `${prefix}_${randomBytes(4).toString("hex")}`

/** devUrl as `role`, made with `attributes` and the URL's own password, which CI's server checks */
export async function asRole(devUrl: string, role: string, attributes: string): Promise<string> {
	const password = decodeURIComponent(new URL(devUrl).password).replaceAll("'", "''")
	await query(devUrl, `CREATE ROLE ${role} LOGIN ${attributes} PASSWORD '${password}'`)
	const url = new URL(devUrl)
	url.username = role
	return url.toString()
}

/* a connection string to the server's own socket, in the database the replay runs in, as the role that replays */
export const LOOPBACK =
	"format('host=%s port=%s dbname=%s user=%s', split_part(current_setting('unix_socket_directories'), ',', 1), current_setting('port'), current_database(), current_user)"

/**
 * `roles` dropped, with every replay database that holds one of them, by a grant of CONNECT or as its
 * owner, as a replay in flight does when its test timed out. A replay's role that its cleanup left is
 * stale to every other check in the run, whose sweep may drop it first: two sessions dropping one
 * role race in Postgres's catalog, and the loser fails (XX000, "could not find tuple for role"), so
 * each role drops on its own, and a role gone after a failed drop is dropped
 */
export async function dropRoles(...roles: string[]): Promise<void> {
	const holds = roles.map(
		(role) => `datacl::text LIKE '%${role}=%' OR datdba = (SELECT oid FROM pg_roles WHERE rolname = '${role}')`,
	)
	const held = await query(
		pgUrl(),
		`SELECT datname FROM pg_database WHERE datname LIKE 'comb\\_replay\\_%' AND (${holds.join(" OR ")})`,
	)
	for (const { datname } of held) await query(pgUrl(), `DROP DATABASE IF EXISTS ${String(datname)} WITH (FORCE)`)
	for (const role of roles) {
		try {
			await query(pgUrl(), `DROP ROLE IF EXISTS ${role}`)
		} catch (error) {
			if ((await roleOf(role)).length > 0) throw error
		}
	}
}

/**
 * A role name per prefix that no other run holds, each dropped with dropRoles once the calling test
 * ends, by a pass, a failure or a timeout alike: a timeout ends the test without running its body's
 * `finally`, so a drop there leaves the role on the server
 */
export function testRoles<const Prefixes extends readonly string[]>(
	...prefixes: Prefixes
): { [K in keyof Prefixes]: string } {
	const names = prefixes.map((prefix) => unique(prefix))
	onTestFinished(() => dropRoles(...names))
	return names as { [K in keyof Prefixes]: string }
}

/** `role` on the server, with its connection limit, if it exists */
export const roleOf = (role: string): Promise<Array<Record<string, unknown>>> =>
	query(pgUrl(), `SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname = '${role}'`)

/** `role` as the server holds it: its row, its comment and its password's hash, unchanged by any replay */
export const heldRole = (role: string): Promise<Array<Record<string, unknown>>> =>
	query(
		pgUrl(),
		`SELECT a.rolname, a.rolconnlimit, md5(coalesce(a.rolpassword, '')) AS password, d.description FROM pg_authid a LEFT JOIN pg_shdescription d ON d.objoid = a.oid AND d.classoid = 'pg_authid'::regclass WHERE a.rolname = '${role}'`,
	)

/** A history file whose change past its database a replay cannot leave out: what it is, its SQL, and the change it names */
export type HiddenWrite = { change: string; label: string; sql: string }

/**
 * The shapes, each changing `pre` (a role that exists), from inside a DO block, a function, EXECUTE
 * or CALL, some beside making `made`, which the replay adopts; `pre` is reachable by the devUrl role
 * that replays them, a `superuser` or not, and only a superuser reads a password change as a row
 */
export function hiddenWrites(pre: string, made: string, superuser: boolean): HiddenWrite[] {
	return [
		{
			change: `role ${pre} changed (rolconnlimit)`,
			label: "a DO-made role beside an existing role's CONNECTION LIMIT",
			sql: `DO $$ BEGIN CREATE ROLE ${made}; ALTER ROLE ${pre} CONNECTION LIMIT 7; END $$;\n`,
		},
		{
			change: `role ${pre} changed (rolconnlimit)`,
			label: "an existing role's CONNECTION LIMIT inside DO",
			sql: `DO $$ BEGIN ALTER ROLE ${pre} CONNECTION LIMIT 7; END $$;\n`,
		},
		{
			change: `role ${pre} changed (rolconnlimit)`,
			label: "a function that does it",
			sql: `CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ALTER ROLE ${pre} CONNECTION LIMIT 9; END $$;\nSELECT f();\n`,
		},
		{
			change: `comment on role ${pre} added`,
			label: "EXECUTE of built text making a role beside a comment on an existing one",
			sql: `DO $$ BEGIN EXECUTE format('CREATE ROLE %I', '${made}'); EXECUTE format('COMMENT ON ROLE %I IS %L', '${pre}', 'x'); END $$;\n`,
		},
		{
			change: `comment on role ${pre} added`,
			label: "CALL",
			sql: `CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN COMMENT ON ROLE ${pre} IS 'x'; END $$;\nCALL p();\n`,
		},
		{
			change: superuser
				? `role ${pre} changed (rolpassword)`
				: "pg_authid, in a column pg_roles does not show, such as a password",
			label: "a password inside DO",
			sql: `DO $$ BEGIN ALTER ROLE ${pre} PASSWORD 'other'; END $$;\n`,
		},
	]
}

/**
 * The shapes' roles, held from a suite's first test to its last: `pre`, a role with a password that
 * exists; `made` and `beside`, names no role holds; and a CREATEDB CREATEROLE role reached at
 * `mgrUrl()` (made on `serverUrl()`), which `pre` is granted to with ADMIN OPTION
 */
export function shapeRoles(serverUrl: () => string): {
	beside: string
	made: string
	mgrUrl: () => string
	pre: string
} {
	const [pre, made, beside, mgr] = ["pre", "made", "beside", "mgr"].map((name) => unique(`comb_t_${name}`)) as [
		string,
		string,
		string,
		string,
	]
	const held = { mgr: "" }
	beforeAll(async () => {
		await query(pgUrl(), `CREATE ROLE ${pre} NOLOGIN PASSWORD 'kept'`)
		held.mgr = await asRole(serverUrl(), mgr, "CREATEDB CREATEROLE")
		await query(pgUrl(), `GRANT ${pre} TO ${mgr} WITH ADMIN OPTION`)
	})
	afterAll(() => dropRoles(made, beside, pre, mgr))
	return { beside, made, mgrUrl: () => held.mgr, pre }
}
