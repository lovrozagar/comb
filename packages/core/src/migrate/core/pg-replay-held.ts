/**
 * What a file's transaction holds when a VALIDATE in it scans, read from Postgres as check's replay
 * runs the file: a DO block, a function or EXECUTE locks what no
 * rating of the file's text sees, so the replay reads pg_locks before each VALIDATE of the
 * transaction, and check warns of that in place of what the text says (pg-validate.ts). A lock on an
 * index or TOAST table counts as one on the relation it belongs to, as every query of a table opens
 * them. A relation there when the transaction began counts under the name it has at the VALIDATE, as
 * the file names it after a rename or a move (pg-held.ts), or the name it had if the file dropped it;
 * one the file makes, which no other session sees, does not count, as
 * tests/integration/support/pg-locks.ts reads Postgres for the lock oracles. A sequence counts by its
 * own name, as the relation another session's nextval waits on, and for the warning alone the replay
 * reads from pg_depend the tables there when the transaction began whose default or identity calls it.
 */
import type { Calls, Locked } from "./pg-held-types.ts"
import { flag, keyOf, type Node } from "./pg-nodes.ts"
import type { Sql } from "./pg-replay-database.ts"
import type { Replaying } from "./pg-replay-statement.ts"

/** Whether a statement is an ALTER TABLE that validates a constraint, which scans every row */
const validates = (type: string, node: Node): boolean =>
	type === "AlterTableStmt" &&
	node["objtype"] === "OBJECT_TABLE" &&
	(node["cmds"] as Node[]).some((each) => (each["AlterTableCmd"] as Node)["subtype"] === "AT_ValidateConstraint")

/* whether a transaction statement starts a transaction: a BEGIN, or a COMMIT or ROLLBACK AND CHAIN */
const opens = (node: Node): boolean => {
	const kind = String(node["kind"])
	return kind === "TRANS_STMT_BEGIN" || kind === "TRANS_STMT_START" || flag(node["chain"])
}

/*
 * Each table, view, materialized view, foreign table and sequence another session sees, out of the
 * system's schemas and no temporary one, by its oid, and each index and TOAST table of one and each
 * TOAST table's index, under the oid, schema and name of the relation it belongs to, and whether that
 * is a sequence
 */
const OWNED = `WITH owner AS (
  SELECT c.oid, c.oid AS of FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
), part AS (
  SELECT oid, of FROM owner
  UNION ALL SELECT c.reltoastrelid, o.of FROM owner o JOIN pg_class c ON c.oid = o.oid WHERE c.reltoastrelid <> 0
), named AS (
  SELECT p.oid, p.of FROM part p
  UNION ALL SELECT x.indexrelid, p.of FROM part p JOIN pg_index x ON x.indrelid = p.oid
)
SELECT d.oid::int8::text AS oid, d.of::int8::text AS of, n.nspname AS schema, c.relname AS name,
  c.relkind = 'S' AS sequence
FROM named d JOIN pg_class c ON c.oid = d.of JOIN pg_namespace n ON n.oid = c.relnamespace`

/* each relation's schema and name now, of the oids a comma-separated list names */
const NAMES = `SELECT c.oid::int8::text AS oid, n.nspname AS schema, c.relname AS name
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid::int8::text = ANY (string_to_array($1, ','))`

/*
 * The tables whose column default calls one of the sequences a comma-separated list names, by oid,
 * and the table whose identity column does: a default's pg_attrdef row depends on the sequence it
 * calls, and an identity's sequence depends internally on its table
 */
const CALLS = `SELECT d.refobjid::int8::text AS sequence, a.adrelid::int8::text AS caller, false AS identity
FROM pg_depend d JOIN pg_attrdef a ON a.oid = d.objid
WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_class'::regclass
  AND d.refobjid::int8::text = ANY (string_to_array($1, ','))
UNION
SELECT d.objid::int8::text, d.refobjid::int8::text, true
FROM pg_depend d
WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'i'
  AND d.objid::int8::text = ANY (string_to_array($1, ','))`

/**
 * A relation another session sees: the oid of the relation it belongs to, that one's key when the
 * transaction began, and whether it is a sequence
 */
type Owned = { key: string; of: string; sequence: boolean }

/** The relations the transaction just begun on `sql` can block, by oid, keyed as comb keys a name under `schema` */
async function heldBefore(sql: Sql, schema: string): Promise<Map<string, Owned>> {
	const rows = await sql.unsafe(OWNED, [])
	return new Map(
		rows.map((row) => [
			String(row["oid"]),
			{
				key: keyOf([String(row["schema"]), String(row["name"])], schema),
				of: String(row["of"]),
				sequence: row["sequence"] === true,
			},
		]),
	)
}

// lookup-table: the lock modes that block another session's writes, and the one that blocks its reads too
const BLOCKING: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"AccessExclusiveLock",
	"ExclusiveLock",
	"ShareLock",
	"ShareRowExclusiveLock",
])

/** Of the sequences `sequences` names by oid, the tables there when the transaction began that call each, by oid */
async function callersOf(
	sql: Sql,
	sequences: readonly string[],
	before: ReadonlyMap<string, Owned>,
): Promise<Array<{ caller: string; identity: boolean; sequence: string }>> {
	if (sequences.length === 0) return []
	const rows = await sql.unsafe(CALLS, [sequences.join(",")])
	return rows
		.map((row) => ({
			caller: String(row["caller"]),
			identity: row["identity"] === true,
			sequence: String(row["sequence"]),
		}))
		.filter(({ caller }) => before.get(caller)?.of === caller)
}

/**
 * What the transaction on `sql` holds of the relations `before` names: each by its key under
 * `schema` now, true when the transaction blocks its reads and writes, false when its writes alone,
 * and of each sequence it holds, the tables that call it, by their keys now
 */
async function heldNow(sql: Sql, before: ReadonlyMap<string, Owned>, schema: string): Promise<Locked> {
	const rows = await sql.unsafe(
		"SELECT relation::int8::text AS oid, mode FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation' AND granted",
		[],
	)
	const locks = rows.flatMap((row) => {
		const owned = before.get(String(row["oid"]))
		const mode = String(row["mode"])
		return owned === undefined || !BLOCKING.has(mode) ? [] : [{ mode, owned }]
	})
	const held = new Map<string, boolean>()
	const calls = new Map<string, Calls>()
	if (locks.length === 0) return { calls, locks: held }
	const sequences = [...new Set(locks.filter(({ owned }) => owned.sequence).map(({ owned }) => owned.of))]
	const callers = await callersOf(sql, sequences, before)
	const oids = new Set([...locks.map(({ owned }) => owned.of), ...callers.map(({ caller }) => caller)])
	const now = await sql.unsafe(NAMES, [[...oids].join(",")])
	const named = new Map(
		now.map((row) => [String(row["oid"]), keyOf([String(row["schema"]), String(row["name"])], schema)]),
	)
	/* every oid here is one `before` holds, so a name the transaction no longer has is the one it began with */
	const keyOfOid = (oid: string): string => named.get(oid) ?? (before.get(oid) as Owned).key
	for (const { mode, owned } of locks) {
		const key = keyOfOid(owned.of)
		held.set(key, mode === "AccessExclusiveLock" || held.get(key) === true)
	}
	for (const { caller, identity, sequence } of callers) {
		const key = keyOfOid(sequence)
		const was = calls.get(key) ?? { defaults: [], identity: undefined }
		const table = keyOfOid(caller)
		calls.set(
			key,
			identity ? { ...was, identity: table } : { ...was, defaults: [...new Set([...was.defaults, table])].toSorted() },
		)
	}
	return { calls, locks: held }
}

/**
 * What the replay of `file` on `sql` reads of its transactions' locks for `held`: the relations as
 * each transaction begins, and what it holds at each VALIDATE in it; nothing without `held`
 */
function lockReader(
	sql: Sql,
	file: string,
	held: Replaying["held"],
): {
	began(): Promise<void>
	moved(node: Node, open: boolean): Promise<void>
	next(index: number, type: string, node: Node): Promise<void>
} {
	let before: Map<string, Owned> | undefined
	const began = async (): Promise<void> => {
		if (held !== undefined) before = await heldBefore(sql, held.schema)
	}
	return {
		/** a transaction of the file begins */
		began: began,
		/** a transaction statement ran, after which a transaction is open when `open` */
		async moved(node: Node, open: boolean): Promise<void> {
			if (!open) before = undefined
			else if (opens(node)) await began()
		},
		/** the `index`th statement, of type `type`, is about to run */
		async next(index: number, type: string, node: Node): Promise<void> {
			if (held !== undefined && before !== undefined && validates(type, node))
				held.at(file, index, await heldNow(sql, before, held.schema))
		},
	}
}

export { heldBefore, heldNow, lockReader, opens, validates }
