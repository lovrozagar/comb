/**
 * The server's shared catalogs read as committed, in one query (P1 and P2 of r22): what a bare
 * statement changed, which no transaction counts, and what a second connection committed, which this
 * backend's counts never see (pg-server-writes.ts). The read is the server's, another session's work
 * in it too, so each row carries the names of the objects it is about, and a change is a file's only
 * when one is a name the file spells (namesIn in sql-code.ts). A replay's own rows are left out.
 */
import type { Sql } from "./pg-replay-database.ts"
import { CATALOGS, changedFields } from "./pg-server-writes.ts"

/* the roles a replay made, by the tag their comment carries */
const TAGGED =
	"(SELECT objoid FROM pg_shdescription WHERE classoid = 'pg_authid'::regclass AND description LIKE 'comb\\_replay %')"
const REPLAY_SETTING = "(SELECT datname FROM pg_database WHERE oid = setdatabase) LIKE 'comb\\_replay\\_%'"
const REPLAY_OBJECT = "(SELECT datname FROM pg_database WHERE oid = objoid) LIKE 'comb\\_replay\\_%'"

// lookup-table: each catalog's rows a replay makes, by the columns its query reads: they are no file's change
const REPLAYS: Readonly<Record<string, { from: string; mine: string }>> = {
	pg_auth_members: { from: "pg_auth_members m", mine: `m.roleid IN ${TAGGED} OR m.member IN ${TAGGED}` },
	pg_authid: { from: "pg_roles r", mine: `r.oid IN ${TAGGED}` },
	pg_database: { from: "pg_database d", mine: "d.datname LIKE 'comb\\_replay\\_%'" },
	pg_db_role_setting: {
		from: "pg_db_role_setting",
		mine: `${REPLAY_SETTING} AND (setrole = 0 OR setrole IN ${TAGGED})`,
	},
	pg_shdescription: {
		from: "pg_shdescription",
		mine: `(classoid = 'pg_authid'::regclass AND objoid IN ${TAGGED}) OR (classoid = 'pg_database'::regclass AND ${REPLAY_OBJECT})`,
	},
	pg_shseclabel: {
		from: "pg_shseclabel",
		mine: `(classoid = 'pg_authid'::regclass AND objoid IN ${TAGGED}) OR (classoid = 'pg_database'::regclass AND ${REPLAY_OBJECT})`,
	},
}

/**
 * Every shared catalog's committed rows in one read, a replay's own left out: each catalog's query
 * with the rows a replay makes filtered where it reads them, and the names each row is about
 */
function snapshotRead(): string {
	return Object.entries(CATALOGS)
		.map(([catalog, { names, noun, query }]) => {
			const replays = REPLAYS[catalog]
			const read = (
				replays === undefined
					? query
					: query.replace(` FROM ${replays.from}`, ` FROM ${replays.from} WHERE NOT (${replays.mine})`)
			).replace(" AS row FROM ", ` AS row, array_remove(${names}, NULL)::text[] AS names FROM `)
			return `SELECT ${literalOf(noun)} AS noun, q.key::text AS key, q.row, q.names FROM (${read}) q`
		})
		.join(" UNION ALL ")
}
const SNAPSHOT = /* @__PURE__ */ snapshotRead()

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
 * The read prepared on `admin` for snapshot: planning it is half its time, and a replay reads it
 * around every file and bare statement
 */
async function prepareSnapshot(admin: Sql): Promise<void> {
	await admin.unsafe(`PREPARE comb_snapshot AS ${SNAPSHOT}`, [])
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
 * name in `names`, the names a file spells (P2 of r22), when given
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

/** The roles and databases named in `names` that `after` holds and `before` does not */
function added(
	before: Snapshot,
	after: Snapshot,
	names: ReadonlySet<string>,
): { databases: string[]; roles: string[] } {
	const out = { databases: [] as string[], roles: [] as string[] }
	for (const subject of after.keys()) {
		if (before.has(subject) || !about(subject, { after, before }, names)) continue
		if (subject.startsWith("role ")) out.roles.push(subject.slice("role ".length))
		else if (subject.startsWith("database ")) out.databases.push(subject.slice("database ".length))
	}
	return out
}

export { added, prepareSnapshot, type Snapshot, snapshot, snapshotChanges }
