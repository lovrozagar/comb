/**
 * What a replayed transaction wrote past its database (P1 of r21), read from Postgres, never from the
 * file's text: a DO block, a function, EXECUTE and CALL hide a role's or a database's change from the
 * parse tree. `pg_stat_xact_sys_tables` counts this backend's own writes to each shared catalog in the
 * open transaction, for any role and before COMMIT, so another session's work never trips it;
 * pg_shdepend is left out, which a GRANT on a table or an owner moves. The catalogs devUrl's role can
 * read then name the change: the open transaction sees it, a second connection sees the server as it
 * was. A role cannot read pg_authid unless it is a superuser, so a role is read from pg_roles, and a
 * write it does not show, such as a password, is named as one. Probed on Postgres 17 as a superuser
 * and as a CREATEDB CREATEROLE role (.tmp/grunt/r21-premise/p1-xact-stats.log, p1-snapshot.log).
 */
import type { Sql } from "./pg-replay-database.ts"
import { ReplayFailed } from "./replay-failed.ts"

/** Writes by shared catalog: how many rows the open transaction inserted, updated or deleted in each */
type Writes = Map<string, number>

/* the counts in one read, a round trip each guarded statement and file saves: track_counts, and the open transaction's writes by shared catalog */
const COUNTS =
	"SELECT current_setting('track_counts') AS on, coalesce((SELECT json_object_agg(s.relname, s.n_tup_ins + s.n_tup_upd + s.n_tup_del) FROM pg_stat_xact_sys_tables s JOIN pg_class c ON c.oid = s.relid WHERE c.relisshared AND c.relkind = 'r' AND s.relname <> 'pg_shdepend'), '{}') AS writes"

/**
 * Whether the server counts this backend's writes, which with `track_counts` off read as none, and
 * the open transaction's writes to each shared catalog, pg_shdepend aside
 */
async function counts(sql: Sql): Promise<{ on: boolean; writes: Writes }> {
	const [row] = await sql.unsafe(COUNTS, [])
	const writes = (row?.["writes"] ?? {}) as Record<string, number>
	return { on: row?.["on"] === "on", writes: new Map(Object.entries(writes).map(([name, n]) => [name, Number(n)])) }
}

/** The writes in `after` that `before` does not account for, by catalog */
function writesSince(after: Writes, before: Writes): Writes {
	const out: Writes = new Map()
	for (const [catalog, n] of after) {
		const was = before.get(catalog) ?? 0
		if (n > was) out.set(catalog, n - was)
	}
	return out
}

/** `more` added into `into` */
function addWrites(into: Writes, more: Writes): void {
	for (const [catalog, n] of more) into.set(catalog, (into.get(catalog) ?? 0) + n)
}

/** What a shared comment or security label is on, named as a change names its subject */
const ROLE_NAME = "(SELECT rolname FROM pg_roles WHERE oid = objoid)"
const SUBJECT = `CASE classoid WHEN 'pg_authid'::regclass THEN 'role ' || ${ROLE_NAME} WHEN 'pg_database'::regclass THEN 'database ' || (SELECT datname FROM pg_database WHERE oid = objoid) WHEN 'pg_tablespace'::regclass THEN 'tablespace ' || (SELECT spcname FROM pg_tablespace WHERE oid = objoid) ELSE classoid::regclass || ' ' || objoid END`

/* the name of the role or database a shared comment or security label is on, as stored */
const OBJECT_NAME = `CASE classoid WHEN 'pg_authid'::regclass THEN ${ROLE_NAME} WHEN 'pg_database'::regclass THEN (SELECT datname FROM pg_database WHERE oid = objoid) WHEN 'pg_tablespace'::regclass THEN (SELECT spcname FROM pg_tablespace WHERE oid = objoid) END`

// lookup-table: how each shared catalog's rows read to a role that is not a superuser, each by a key the change names, what a row is, and the names it is about as stored
const CATALOGS: Readonly<Record<string, { names: string; noun: string; query: string }>> = {
	pg_auth_members: {
		names:
			"ARRAY[(SELECT rolname FROM pg_roles WHERE oid = m.roleid), (SELECT rolname FROM pg_roles WHERE oid = m.member)]",
		noun: "membership",
		query:
			"SELECT roleid::regrole || ' to ' || member::regrole || ' by ' || grantor::regrole AS key, to_jsonb(m) - 'oid' - 'roleid' - 'member' - 'grantor' AS row FROM pg_auth_members m",
	},
	pg_authid: {
		names: "ARRAY[r.rolname]",
		noun: "role",
		query: "SELECT rolname AS key, to_jsonb(r) - 'oid' - 'rolpassword' AS row FROM pg_roles r",
	},
	pg_database: {
		names: "ARRAY[d.datname]",
		noun: "database",
		query: "SELECT datname AS key, to_jsonb(d) - 'oid' - 'datfrozenxid' - 'datminmxid' AS row FROM pg_database d",
	},
	pg_db_role_setting: {
		names:
			"ARRAY[(SELECT datname FROM pg_database WHERE oid = setdatabase), (SELECT rolname FROM pg_roles WHERE oid = setrole)]",
		noun: "setting",
		query:
			"SELECT coalesce((SELECT datname FROM pg_database WHERE oid = setdatabase), 'every database') || ' for ' || CASE WHEN setrole = 0 THEN 'every role' ELSE setrole::regrole::text END AS key, to_jsonb(setconfig) AS row FROM pg_db_role_setting",
	},
	pg_parameter_acl: {
		names: "ARRAY[parname]",
		noun: "privilege on parameter",
		query: "SELECT parname AS key, to_jsonb(paracl) AS row FROM pg_parameter_acl",
	},
	pg_replication_origin: {
		names: "ARRAY[roname]",
		noun: "replication origin",
		query: "SELECT roname AS key, '{}'::jsonb AS row FROM pg_replication_origin",
	},
	pg_shdescription: {
		names: `ARRAY[${OBJECT_NAME}]`,
		noun: "comment on",
		query: `SELECT ${SUBJECT} AS key, to_jsonb(description) AS row FROM pg_shdescription`,
	},
	pg_shseclabel: {
		names: `ARRAY[${OBJECT_NAME}]`,
		noun: "security label on",
		query: `SELECT ${SUBJECT} || ' by ' || provider AS key, to_jsonb(label) AS row FROM pg_shseclabel`,
	},
	pg_subscription: {
		names: "ARRAY[subname]",
		noun: "subscription",
		query:
			"SELECT subname AS key, jsonb_build_object('owner', subowner::regrole, 'enabled', subenabled, 'database', subdbid) AS row FROM pg_subscription",
	},
	pg_tablespace: {
		names: "ARRAY[t.spcname]",
		noun: "tablespace",
		query: "SELECT spcname AS key, to_jsonb(t) - 'oid' AS row FROM pg_tablespace t",
	},
}

/** A catalog's rows as `sql` reads them, by key */
async function rowsOf(sql: Sql, query: string): Promise<Map<string, Record<string, unknown>>> {
	const rows = await sql.unsafe(query, [])
	return new Map(rows.map((row) => [String(row["key"]), row["row"] as Record<string, unknown>]))
}

/** The fields of a row that differ, in order */
const changedFields = (before: Record<string, unknown>, after: Record<string, unknown>): string[] =>
	[...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
		.sort()

/** How a counted catalog with no row to name reads: a write devUrl's role cannot see */
const unseen = (catalog: string): string =>
	catalog === "pg_authid"
		? "pg_authid, in a column pg_roles does not show, such as a password"
		: `${catalog}, in a row devUrl's role cannot read`

/** Rows by subject, each as JSON: what comb's own CREATE ROLE left them */
type Rows = Map<string, string>

/** The rows of the catalogs `written` that `mine` names, as the open transaction on `sql` reads them */
async function subjectRows(sql: Sql, written: Writes, mine: (subject: string) => boolean): Promise<Rows> {
	const out: Rows = new Map()
	for (const catalog of written.keys()) {
		const read = CATALOGS[catalog]
		if (read === undefined) continue
		for (const [key, row] of await rowsOf(sql, read.query))
			if (mine(`${read.noun} ${key}`)) out.set(`${read.noun} ${key}`, JSON.stringify(row))
	}
	return out
}

/**
 * What the `counted` writes changed, as the open transaction on `sql` sees the server against the
 * committed server `was` reads, one change per row; a row still as comb's own CREATE ROLE left it
 * (`ours`) is comb's, which the change leaves out
 */
async function namedChanges({ sql, was }: { sql: Sql; was: Sql }, counted: Writes, ours: Rows): Promise<string[]> {
	const changes: string[] = []
	for (const catalog of [...counted.keys()].sort()) {
		const read = CATALOGS[catalog]
		if (read === undefined) {
			changes.push(unseen(catalog))
			continue
		}
		const [before, after] = [await rowsOf(was, read.query), await rowsOf(sql, read.query)]
		const named: string[] = []
		for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
			const [from, to] = [before.get(key), after.get(key)]
			const subject = `${read.noun} ${key}`
			if (to !== undefined && ours.get(subject) === JSON.stringify(to)) continue
			if (from === undefined) named.push(`${subject} added`)
			else if (to === undefined) named.push(`${subject} removed`)
			else {
				const fields = changedFields(from, to)
				if (fields.length > 0) named.push(`${subject} changed (${fields.join(", ")})`)
			}
		}
		changes.push(...(named.length > 0 ? named : [unseen(catalog)]))
	}
	return changes
}

/** Refuses a devUrl whose server keeps no counts for its role: the replay would read every file's writes as none */
async function refuseUncounted(sql: Sql, stops: string): Promise<void> {
	if ((await counts(sql)).on) return
	throw new ReplayFailed(
		`devUrl's server keeps no counts for its role (track_counts is off), and comb reads from them what a history file changes past its database; set track_counts on for devUrl's role or server; ${stops}`,
	)
}

export {
	addWrites,
	CATALOGS,
	changedFields,
	counts,
	namedChanges,
	refuseUncounted,
	type Rows,
	subjectRows,
	type Writes,
	writesSince,
}
