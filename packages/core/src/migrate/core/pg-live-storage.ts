/**
 * Where the target keeps each relation's rows, read from its catalog for a check or apply whose
 * pending files move a relation: a table, materialized view or index the history made without USING
 * or TABLESPACE went where the target's default_table_access_method and default_tablespace put it,
 * which its history cannot say, so its catalog does (pg-storage.ts). A relation in the database's
 * own tablespace records none (reltablespace 0), and Postgres reads a move to that tablespace's name
 * as a move to none, so it reads as that name here.
 */
import { type Connect, failureOf, loadPostgres } from "./pg-live-objects.ts"
import type { LiveTarget } from "./pg-live-types.ts"
import { keyOf, type Node, nodesOf } from "./pg-nodes.ts"
import type { Placed, Storage } from "./pg-storage-types.ts"
import { postgresOptionsOf } from "./pg-url.ts"

/** How comb reads where the target keeps its relations: readPlaced, unless a test says otherwise */
type ReadPlaced = (target: LiveTarget) => Promise<Placed | undefined>

/* why comb loads postgres.js here */
const READS = "read where the target keeps a relation a pending file moves"

/* every table, materialized view and index outside the system's schemas, with where it is */
const PLACED = `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, a.amname AS method,
	coalesce(t.spcname, d.spcname) AS tablespace, c.relpersistence AS persistence
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_am a ON a.oid = c.relam
LEFT JOIN pg_catalog.pg_tablespace t ON t.oid = c.reltablespace
CROSS JOIN (SELECT s.spcname FROM pg_catalog.pg_database b
	JOIN pg_catalog.pg_tablespace s ON s.oid = b.dattablespace WHERE b.datname = current_database()) d
WHERE c.relkind IN ('r', 'm', 'i') AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`

/** The rows of PLACED as Placed, keyed under `schema` as the history's facts are */
function placedOf(rows: ReadonlyArray<Record<string, unknown>>, schema: string): Placed {
	const indexes = new Map<string, string>()
	const relations = new Map<string, Storage>()
	for (const row of rows) {
		const key = keyOf([String(row["schema"]), String(row["name"])], schema)
		const tablespace = String(row["tablespace"])
		if (row["kind"] === "i") indexes.set(key, tablespace)
		else relations.set(key, { accessMethod: String(row["method"]), logged: row["persistence"] === "p", tablespace })
	}
	return { indexes, relations }
}

/**
 * Where `target` keeps its relations, by key; undefined without the postgres package, an optional
 * peer, so the files are rated alone. It writes nothing
 */
async function readPlaced(
	target: LiveTarget,
	load: () => Promise<Connect> = () => loadPostgres(READS),
): Promise<Placed | undefined> {
	let connect: Connect
	try {
		connect = await load()
	} catch {
		// reason: the postgres package is an optional peer; without it each move of an unnamed relation warns
		return undefined
	}
	const sql = connect({ ...postgresOptionsOf(target.url, "url"), max: 1 })
	try {
		return placedOf(await sql.unsafe(PLACED, []), target.schema)
	} catch (error) {
		throw new Error(
			`comb could not read where url keeps its relations: ${failureOf(error, { field: "url", url: target.url, urls: [target.url] })}`,
			{ cause: error },
		)
	} finally {
		await sql.end()
	}
}

// lookup-table: the moves whose no-op the history cannot see for a relation made without USING or TABLESPACE
const UNNAMED_MOVES: ReadonlySet<unknown> = /* @__PURE__ */ new Set(["AT_SetAccessMethod", "AT_SetTableSpace"])

/** Whether a parse tree among `trees` moves a relation to an access method or a tablespace */
const movesStorage = (trees: readonly unknown[]): boolean =>
	trees.some((tree) =>
		nodesOf(tree).some(([type, node]) => type === "AlterTableCmd" && UNNAMED_MOVES.has((node as Node)["subtype"])),
	)

export { movesStorage, placedOf, type ReadPlaced, readPlaced }
