/**
 * Roles on the test server, for the replay suites: a name no other run holds, a devUrl reached as a
 * role of its own, a role's row and comment as the server holds them. And P1 of r21's shapes: a
 * history file whose change past its database hides inside a statement the replay cannot leave
 * out, so only Postgres can say what it wrote.
 */
import { randomBytes } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll } from "vitest"
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

export const dropRoles = (...roles: string[]): Promise<unknown> =>
	query(pgUrl(), `DROP ROLE IF EXISTS ${roles.join(", ")}`)

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
 * The shapes, each changing `pre` (a role that exists) or making `made`, from inside a DO block, a
 * function, EXECUTE or CALL; `pre` is reachable by the devUrl role that replays them
 */
export function hiddenWrites(pre: string, made: string): HiddenWrite[] {
	return [
		{ change: `role ${made} added`, label: "a DO-made role", sql: `DO $$ BEGIN CREATE ROLE ${made}; END $$;\n` },
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
			change: `role ${made} added`,
			label: "EXECUTE of built text",
			sql: `DO $$ BEGIN EXECUTE format('CREATE ROLE %I', '${made}'); END $$;\n`,
		},
		{
			change: `comment on role ${pre} added`,
			label: "CALL",
			sql: `CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN COMMENT ON ROLE ${pre} IS 'x'; END $$;\nCALL p();\n`,
		},
		{
			change: "pg_authid, in a column pg_roles does not show, such as a password",
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
