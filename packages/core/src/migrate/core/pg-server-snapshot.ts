/**
 * The server's shared catalogs read as committed, in one query: what a bare
 * statement changed, which no transaction counts, and what a second connection committed, which this
 * backend's counts never see (pg-server-writes.ts). The read is the server's, another session's work
 * in it too, so each row carries the names of the objects it is about, and a change is a file's only
 * when one is a name the file spells (namesIn in sql-code.ts). A replay's own rows are left out, but
 * for the fields of its own database's row that keep the cleanup from dropping it, which only that
 * replay changes. Beside the catalogs, the server's replication slots, which no catalog
 * holds.
 */
import type { Sql } from "./pg-replay-database.ts"
import { type Catalog, catalogsOf, changedFields } from "./pg-server-writes.ts"

/* the roles a replay made, by the tag their comment carries */
const TAGGED =
	"(SELECT objoid FROM pg_shdescription WHERE classoid = 'pg_authid'::regclass AND description LIKE 'comb\\_replay %')"
/* a setting for every database has no datname, and NOT of a NULL would drop its row too; a comment's too, by construction */
const REPLAY_SETTING =
	"coalesce((SELECT datname FROM pg_database WHERE oid = setdatabase) LIKE 'comb\\_replay\\_%', false)"
const REPLAY_OBJECT = "coalesce((SELECT datname FROM pg_database WHERE oid = objoid) LIKE 'comb\\_replay\\_%', false)"

/* a shared comment's or security label's row a replay makes: on a role it tagged, or on its database */
const REPLAY_SHARED = `(classoid = 'pg_authid'::regclass AND objoid IN ${TAGGED}) OR (classoid = 'pg_database'::regclass AND ${REPLAY_OBJECT})`

// lookup-table: each catalog's rows a replay makes, by the columns its query reads, which ends at its FROM: they are no file's change
const REPLAYS: Readonly<Record<string, string>> = {
	pg_auth_members: `m.roleid IN ${TAGGED} OR m.member IN ${TAGGED}`,
	pg_authid: `r.oid IN ${TAGGED}`,
	pg_database: "d.datname LIKE 'comb\\_replay\\_%'",
	/* a role it tagged takes each of its settings with it, every database's too, as an ALTER ROLE … SET of a role it made writes */
	pg_db_role_setting: `(${REPLAY_SETTING} AND setrole = 0) OR setrole IN ${TAGGED}`,
	pg_shdescription: REPLAY_SHARED,
	pg_shseclabel: REPLAY_SHARED,
}

/*
 * the names a catalog's row is about as the snapshot reads them, where they differ from the counts'
 * read: a setting for every role, which ALTER ROLE ALL makes, is about `all`, the word
 * the file spells; only here, so the counts' read never takes a role named all for every role
 */
const NAMES: Readonly<Record<string, string>> = {
	pg_db_role_setting:
		"ARRAY[(SELECT datname FROM pg_database WHERE oid = setdatabase), CASE WHEN setrole = 0 THEN 'all' ELSE (SELECT rolname FROM pg_roles WHERE oid = setrole) END]",
}

// lookup-table: what the server holds beside its catalogs, read as the catalogs are: a slot's fields that do not move as it is used
const BESIDE: Readonly<Record<string, Catalog>> = {
	pg_replication_slots: {
		names: "ARRAY[s.slot_name::text]",
		noun: "replication slot",
		query:
			"SELECT slot_name AS key, jsonb_build_object('type', slot_type, 'plugin', plugin, 'database', database, 'temporary', temporary) AS row FROM pg_replication_slots s",
	},
}

/**
 * The replay's own database's row, filtered from pg_database's above, by the fields whose change
 * keeps the cleanup from dropping it: a template, another owner. A committing DO runs bare, which no
 * count sees, so the snapshot reads them, keyed as pg_database's row and so named alike
 */
const ownDatabase = (database: string): string =>
	`SELECT 'database' AS noun, d.datname::text AS key, jsonb_build_object('datdba', d.datdba, 'datistemplate', d.datistemplate) AS row, ARRAY[d.datname::text] AS names FROM pg_database d WHERE d.datname = ${literalOf(database)}`

/**
 * Every shared catalog's committed rows in one read, as devUrl's role reads them (a `superuser`
 * reads pg_authid), a replay's own left out: each catalog's query with the rows a replay makes
 * filtered, and the names each row is about
 */
function snapshotRead(superuser: boolean): string {
	return Object.entries({ ...catalogsOf(superuser), ...BESIDE })
		.map(([catalog, { names: stored, noun, query }]) => {
			const names = NAMES[catalog] ?? stored
			const replays = REPLAYS[catalog]
			const read = (replays === undefined ? query : `${query} WHERE NOT (${replays})`).replace(
				" AS row FROM ",
				` AS row, array_remove(${names}, NULL)::text[] AS names FROM `,
			)
			return `SELECT ${literalOf(noun)} AS noun, q.key::text AS key, q.row, q.names FROM (${read}) q`
		})
		.join(" UNION ALL ")
}

/** `text` as a SQL string literal */
function literalOf(text: string): string {
	return `'${text.replaceAll("'", "''")}'`
}

/**
 * The server's shared catalogs as committed, a replay's own rows left out: each row's JSON by its
 * subject, with the names of the roles, databases or other objects the row is about, as stored
 */
type Snapshot = Map<string, { names: readonly string[]; row: Record<string, unknown> }>

/**
 * The read prepared on `admin` for snapshot, as its role reads it, with the replay's own
 * `database`'s row: planning it is half its time, and a replay reads it around every file and bare
 * statement
 */
async function prepareSnapshot(
	admin: Sql,
	{ database, superuser }: { database: string; superuser: boolean },
): Promise<void> {
	await admin.unsafe(`PREPARE comb_snapshot AS ${snapshotRead(superuser)} UNION ALL ${ownDatabase(database)}`, [])
}

/** The shared catalogs as `admin`, a connection with no transaction open that prepareSnapshot prepared, reads them committed */
async function snapshot(admin: Sql): Promise<Snapshot> {
	const rows = await admin.unsafe("EXECUTE comb_snapshot", [])
	return new Map(
		rows.map((row) => [
			`${String(row["noun"])} ${String(row["key"])}`,
			{ names: row["names"] as string[], row: row["row"] as Record<string, unknown> },
		]),
	)
}

/* whether the row a subject is in `before` or `after` is about a name in `names`; every row is without them */
const about = (
	subject: string,
	{ after, before }: { after: Snapshot; before: Snapshot },
	names?: ReadonlySet<string>,
) =>
	names === undefined ||
	[before.get(subject), after.get(subject)].some((at) => at?.names.some((name) => names.has(name)))

/**
 * What changed from `before` to `after`, one change per subject, in order: of a subject about a
 * name in `names`, the names a file spells, when given
 */
function snapshotChanges(before: Snapshot, after: Snapshot, names?: ReadonlySet<string>): string[] {
	const changes: string[] = []
	for (const subject of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		if (!about(subject, { after, before }, names)) continue
		const [from, to] = [before.get(subject)?.row, after.get(subject)?.row]
		if (from === undefined) changes.push(`${subject} added`)
		else if (to === undefined) changes.push(`${subject} removed`)
		else {
			const fields = changedFields(from, to)
			if (fields.length > 0) changes.push(`${subject} changed (${fields.join(", ")})`)
		}
	}
	return changes
}

/** What the cleanup drops, by the noun its subject starts with */
type Strays = { databases: string[]; roles: string[]; slots: string[] }

// lookup-table: the nouns of what a file adds that the cleanup drops, by where it keeps them
const DROPPED: ReadonlyArray<[keyof Strays, string]> = [
	["databases", "database "],
	["roles", "role "],
	["slots", "replication slot "],
]

/** The roles, databases and replication slots named in `names` that `after` holds and `before` does not */
function added(before: Snapshot, after: Snapshot, names: ReadonlySet<string>): Strays {
	const out: Strays = { databases: [], roles: [], slots: [] }
	for (const subject of after.keys()) {
		if (before.has(subject) || !about(subject, { after, before }, names)) continue
		const [where, noun] = DROPPED.find(([, prefix]) => subject.startsWith(prefix)) ?? []
		if (where !== undefined) out[where].push(subject.slice(noun?.length))
	}
	return out
}

export { added, prepareSnapshot, type Snapshot, snapshot, snapshotChanges, type Strays }
