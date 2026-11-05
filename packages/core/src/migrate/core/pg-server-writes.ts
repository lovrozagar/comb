/**
 * What a replayed transaction wrote past its database, read from Postgres, never from the
 * file's text: a DO block, a function, EXECUTE and CALL hide a role's or a database's change from the
 * parse tree. `pg_stat_xact_sys_tables` counts this backend's own writes to each shared catalog in the
 * open transaction, for any role and before COMMIT, so another session's work never trips it;
 * pg_shdepend is left out, which a GRANT on a table or an owner moves. The catalogs devUrl's role can
 * read then name the change: the open transaction sees it, a second connection sees the server as it
 * was. A role cannot read pg_authid unless it is a superuser, so a role is read from pg_roles, and a
 * write it does not show, such as a password, is named as one; a superuser reads pg_authid, a
 * password as its hash, so a password's change is named by its role. Probed on Postgres 17 as a superuser
 * and as a CREATEDB CREATEROLE role (p1-snapshot.log).
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
const CATALOGS: Readonly<Record<string, Catalog>> = {
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
	/* a subscription lives in a database, and is about it: one in the replay's is the file's, which its drop takes */
	pg_subscription: {
		names: "ARRAY[subname, (SELECT datname FROM pg_database WHERE oid = subdbid)::text]",
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

/** How a catalog's rows read: the names each is about, what a row is, and its query */
type Catalog = { names: string; noun: string; query: string }

/* a role's row as a superuser reads it: pg_authid, its password as a hash, so no row holds one */
const AUTHID: Catalog = {
	names: "ARRAY[r.rolname]",
	noun: "role",
	query:
		"SELECT rolname AS key, to_jsonb(r) - 'oid' - 'rolpassword' || jsonb_build_object('rolpassword', encode(sha256(convert_to(coalesce(r.rolpassword, ''), 'UTF8')), 'hex')) AS row FROM pg_authid r",
}

/** The shared catalogs as devUrl's role reads them: pg_authid itself when it is a `superuser` */
const catalogsOf = (superuser: boolean): Readonly<Record<string, Catalog>> =>
	superuser ? { ...CATALOGS, pg_authid: AUTHID } : CATALOGS

/** A row of a catalog: the names it is about, as stored, each where its catalog puts it, and the row */
type Row = { names: ReadonlyArray<string | null>; row: Record<string, unknown> }

/** A catalog's rows as `sql` reads them, by key */
async function rowsOf(sql: Sql, { names, query }: Catalog): Promise<Map<string, Row>> {
	const rows = await sql.unsafe(query.replace(" AS row FROM ", ` AS row, ${names}::text[] AS names FROM `), [])
	return new Map(
		rows.map((row) => [
			String(row["key"]),
			{ names: row["names"] as Array<string | null>, row: row["row"] as Record<string, unknown> },
		]),
	)
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

/** One row's change: its kind, its subject, the names it is about, the fields that changed, none when added or removed, and how it reads */
type Change = {
	fields: string[]
	kind: "added" | "changed" | "removed"
	names: ReadonlyArray<string | null>
	said: string
	subject: string
}

/** Whether a change is the replay's own */
type Own = (change: Change) => boolean

/** The rows of the catalogs `written` that `mine` names, as the open transaction on `sql` reads them through `catalogs` */
async function subjectRows(
	{ catalogs, sql }: { catalogs: Readonly<Record<string, Catalog>>; sql: Sql },
	written: Writes,
	mine: (subject: string) => boolean,
): Promise<Rows> {
	const out: Rows = new Map()
	for (const catalog of written.keys()) {
		const read = catalogs[catalog]
		if (read === undefined) continue
		for (const [key, { row }] of await rowsOf(sql, read))
			if (mine(`${read.noun} ${key}`)) out.set(`${read.noun} ${key}`, JSON.stringify(row))
	}
	return out
}

/** What one row's change is, `subject` from `from` to `to`; undefined when nothing changed, nor a row on either side */
function changeOf(subject: string, from: Row | undefined, to: Row | undefined): Change | undefined {
	if (from === undefined) return to && { fields: [], kind: "added", names: to.names, said: `${subject} added`, subject }
	if (to === undefined) return { fields: [], kind: "removed", names: from.names, said: `${subject} removed`, subject }
	const fields = changedFields(from.row, to.row)
	return fields.length === 0
		? undefined
		: { fields, kind: "changed", names: to.names, said: `${subject} changed (${fields.join(", ")})`, subject }
}

/**
 * What the `counted` writes changed, by catalog in order, as the open transaction on `sql` sees the
 * server against the committed server `was` reads, through `catalogs`, one change per row; a row
 * still as comb's own CREATE ROLE left it (`ours`) is comb's, and no change. The committed server is
 * read before the transaction's read and after it, and a change is one only against both: what
 * another session commits meanwhile, on a server others share, is in one of them
 */
async function rowChanges(
	{ catalogs, sql, was }: { catalogs: Readonly<Record<string, Catalog>>; sql: Sql; was: Sql },
	counted: Writes,
	ours: Rows,
): Promise<Map<string, Change[]>> {
	const out = new Map<string, Change[]>()
	for (const catalog of [...counted.keys()].sort()) {
		const read = catalogs[catalog]
		/* a catalog it has no read for has no row to name */
		if (read === undefined) {
			out.set(catalog, [])
			continue
		}
		/* the committed server read on both sides of the transaction's own read: another session's commit between them is in one */
		const [before, after, again] = [await rowsOf(was, read), await rowsOf(sql, read), await rowsOf(was, read)]
		const changes: Change[] = []
		for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
			const to = after.get(key)
			const subject = `${read.noun} ${key}`
			if (to !== undefined && ours.get(subject) === JSON.stringify(to.row)) continue
			const change = changeOf(subject, before.get(key), to)
			if (change !== undefined && changeOf(subject, again.get(key), to) !== undefined) changes.push(change)
		}
		out.set(catalog, changes)
	}
	return out
}

/**
 * The changes of `byCatalog` the replay must refuse: each that is not its `own`, and a counted
 * catalog with no row to name, a write devUrl's role cannot see; a catalog whose every change is
 * the replay's own counted no other
 */
function refusedChanges(byCatalog: ReadonlyMap<string, Change[]>, own: Own): string[] {
	const out: string[] = []
	for (const [catalog, changes] of byCatalog) {
		const named = changes.filter((change) => !own(change)).map((change) => change.said)
		if (named.length > 0) out.push(...named)
		else if (changes.length === 0) out.push(unseen(catalog))
	}
	return out
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
	type Catalog,
	catalogsOf,
	type Change,
	changedFields,
	counts,
	refusedChanges,
	refuseUncounted,
	type Own,
	rowChanges,
	type Rows,
	subjectRows,
	type Writes,
	writesSince,
}
