/**
 * What a file's transaction holds when a VALIDATE in it scans, read from Postgres as check's replay
 * runs the file (0005 and PA8 of r22b, after PR5): a DO block, a function or EXECUTE locks what no
 * rating of the file's text sees, so the replay reads pg_locks before each VALIDATE of the
 * transaction, and check warns of that in place of what the text says (pg-validate.ts). A lock on an
 * index or TOAST table counts as one on the relation it belongs to, as every query of a table opens
 * them. A relation there when the transaction began counts under the name it has at the VALIDATE, as
 * the file names it after a rename or a move (pg-held.ts), or the name it had if the file dropped it;
 * one the file makes, which no other session sees, does not count, as
 * tests/integration/support/pg-locks.ts reads Postgres for the lock oracles.
 */
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
 * Each table, view, materialized view and foreign table another session sees, out of the system's
 * schemas and no temporary one, by its oid, and each index and TOAST table of one and each TOAST
 * table's index, under the oid, schema and name of the relation it belongs to
 */
const OWNED = `WITH owner AS (
  SELECT c.oid, c.oid AS of FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
), part AS (
  SELECT oid, of FROM owner
  UNION ALL SELECT c.reltoastrelid, o.of FROM owner o JOIN pg_class c ON c.oid = o.oid WHERE c.reltoastrelid <> 0
), named AS (
  SELECT p.oid, p.of FROM part p
  UNION ALL SELECT x.indexrelid, p.of FROM part p JOIN pg_index x ON x.indrelid = p.oid
)
SELECT d.oid::int8::text AS oid, d.of::int8::text AS of, n.nspname AS schema, c.relname AS name
FROM named d JOIN pg_class c ON c.oid = d.of JOIN pg_namespace n ON n.oid = c.relnamespace`

/* each relation's schema and name now, of the oids a comma-separated list names */
const NAMES = `SELECT c.oid::int8::text AS oid, n.nspname AS schema, c.relname AS name
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid::int8::text = ANY (string_to_array($1, ','))`

/** A relation another session sees: the oid of the relation it belongs to, and that one's key when the transaction began */
type Owned = { key: string; of: string }

/** The relations the transaction just begun on `sql` can block, by oid, keyed as comb keys a name under `schema` */
async function heldBefore(sql: Sql, schema: string): Promise<Map<string, Owned>> {
	const rows = await sql.unsafe(OWNED, [])
	return new Map(
		rows.map((row) => [
			String(row["oid"]),
			{ key: keyOf([String(row["schema"]), String(row["name"])], schema), of: String(row["of"]) },
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

/**
 * What the transaction on `sql` holds of the relations `before` names: each by its key under
 * `schema` now, true when the transaction blocks its reads and writes, false when its writes alone
 */
async function heldNow(sql: Sql, before: ReadonlyMap<string, Owned>, schema: string): Promise<Map<string, boolean>> {
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
	if (locks.length === 0) return held
	const now = await sql.unsafe(NAMES, [[...new Set(locks.map(({ owned }) => owned.of))].join(",")])
	const named = new Map(
		now.map((row) => [String(row["oid"]), keyOf([String(row["schema"]), String(row["name"])], schema)]),
	)
	for (const { mode, owned } of locks) {
		const key = named.get(owned.of) ?? owned.key
		held.set(key, mode === "AccessExclusiveLock" || held.get(key) === true)
	}
	return held
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
