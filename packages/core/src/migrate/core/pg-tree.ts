/**
 * Postgres statements read from Postgres's own parser (libpg-query 17, the parser of the server
 * comb migrates), never from their text, so no spelling hides a write: an inheritance star, a
 * Unicode-escaped or unspaced name, a write in a CTE or a rule's action are the nodes they parse to.
 * Every node is walked:
 *
 * - a DELETE is unsafe, whatever its WHERE; a MERGE that updates or deletes is unsafe, and one that
 *   only inserts cautious;
 * - an UPDATE, and an upsert's DO UPDATE, is cautious as a backfill (of a table the file created, or
 *   only of columns it added, each once) and unsafe otherwise;
 * - a write to a table whose trigger the history holds fires it, which is unsafe;
 * - a temp table or view (TEMP, or in `pg_temp`) that takes an existing table's name shadows it for
 *   the rest of the file, as `pg_temp` comes first on the search path; unsafe;
 * - a call of a function that is not a pure built-in (pg-builtins.ts) runs code comb cannot read;
 * - a DO block, and a function, procedure or trigger the file creates, run code comb does not read;
 *   each is unsafe unless the file approves it;
 * - a statement Postgres cannot parse is unsafe.
 *
 * The parser is an optional peer, loaded once by `loadPostgresParser()` (pg-parser.ts).
 */
import type { ExtractedSchema } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import type { Fresh } from "./classify-write.ts"
import { builtinFinding } from "./pg-builtins.ts"
import { postgresParser } from "./pg-parser.ts"

type Node = Record<string, unknown>
/** Every node under `node`, by its type, the type's fields with it */
function nodesOf(node: unknown, out: Array<[string, Node]> = []): Array<[string, Node]> {
	if (Array.isArray(node)) for (const each of node) nodesOf(each, out)
	else if (node !== null && typeof node === "object") {
		for (const [key, value] of Object.entries(node)) {
			if (value !== null && typeof value === "object" && !Array.isArray(value) && /^[A-Z]/.test(key))
				out.push([key, value as Node])
			nodesOf(value, out)
		}
	}
	return out
}

/* the parts of a name, as the parser lists them: each a String node */
const names = (list: unknown): string[] => (list as Array<{ String: { sval: string } }>).map((part) => part.String.sval)

/** A RangeVar's table, by its name and, schema included, its key as comb keys names */
function tableOf(relation: unknown): { key: string; name: string; temp: boolean } {
	const rel = relation as { relname: string; relpersistence: string; schemaname?: string }
	const name = rel.relname
	const key = rel.schemaname === undefined ? name : `${rel.schemaname}.${name}`
	return { key, name, temp: rel.relpersistence === "t" || rel.schemaname === "pg_temp" }
}

/** The columns a SET list assigns */
const assigned = (targets: unknown): string[] =>
	(targets as Array<{ ResTarget: { name: string } }>).map((target) => target.ResTarget.name)

/** The triggers the history holds on `table` for any of `events` */
function firedOn(before: ExtractedSchema | undefined, table: string, events: readonly string[]): Finding[] {
	return (before?.triggers ?? [])
		.filter((trigger) => trigger.table === table && trigger.events.some((event) => events.includes(event)))
		.map((trigger) => ({
			level: "unsafe",
			note: `fires trigger ${trigger.name}, whose body runs for every row it writes`,
		}))
}

/** An UPDATE's or upsert's rating: cautious when it backfills only what `fresh` holds, which it then takes out */
function updateFinding(table: { key: string; name: string }, columns: string[], fresh: Fresh): Finding {
	const added = fresh.columns.get(table.key)
	const backfill =
		fresh.tables.has(table.key) || (columns.length > 0 && columns.every((column) => added?.has(column) === true))
	for (const column of columns) added?.delete(column)
	return backfill
		? { level: "cautious", note: `backfills ${table.name} (${columns.join(", ")}), new in this file` }
		: { level: "unsafe", note: `updates existing rows of ${table.name} (${columns.join(", ")})` }
}

/** A write node's findings: its own rating, and the triggers it fires */
function writeFindings(
	type: string,
	node: Node,
	ctx: { before?: ExtractedSchema | undefined; fresh: Fresh },
): Finding[] {
	const table = tableOf(node["relation"])
	if (type === "DeleteStmt")
		return [{ level: "unsafe", note: `deletes rows of ${table.name}` }, ...firedOn(ctx.before, table.name, ["delete"])]
	if (type === "UpdateStmt")
		return [
			updateFinding(table, assigned(node["targetList"]), ctx.fresh),
			...firedOn(ctx.before, table.name, ["update"]),
		]
	if (type === "MergeStmt") {
		const commands = (node["mergeWhenClauses"] as Array<{ MergeWhenClause: { commandType: string } }>).map(
			(each) => each.MergeWhenClause.commandType,
		)
		const changes = commands.some((command) => command === "CMD_UPDATE" || command === "CMD_DELETE")
		const events = commands.map((command) => command.replace("CMD_", "").toLowerCase())
		return [
			changes
				? { level: "unsafe", note: `merges into ${table.name}, updating or deleting its rows` }
				: { level: "cautious", note: `merges new rows into ${table.name}` },
			...firedOn(ctx.before, table.name, events),
		]
	}
	const conflict = node["onConflictClause"] as Node | undefined
	if (conflict?.["action"] === "ONCONFLICT_UPDATE")
		return [
			updateFinding(table, assigned(conflict["targetList"]), ctx.fresh),
			...firedOn(ctx.before, table.name, ["insert", "update"]),
		]
	return firedOn(ctx.before, table.name, ["insert"])
}

/** A node that runs code comb does not read, or shadows a table: its finding */
function codeFinding(type: string, node: Node, before: ExtractedSchema | undefined): Finding | undefined {
	if (type === "DoStmt") return { level: "unsafe", note: "runs a DO block, whose body comb does not read" }
	if (type === "CreateFunctionStmt") {
		const kind = node["is_procedure"] === true ? "procedure" : "function"
		return {
			level: "unsafe",
			note: `creates ${kind} ${names(node["funcname"]).join(".")}, whose body comb does not read`,
		}
	}
	if (type === "CreateTrigStmt")
		return {
			level: "unsafe",
			note: `creates trigger ${String(node["trigname"])}, which runs a function on later writes`,
		}
	if (type === "FuncCall") return builtinFinding(names(node["funcname"]))
	/* a CALL holds its call as a plain field, not a typed node */
	if (type === "CallStmt") return builtinFinding(names((node["funccall"] as Node)["funcname"]))
	return shadowFinding(type, node, before)
}

/** A temp table or view that takes an existing table's name: its finding */
function shadowFinding(type: string, node: Node, before: ExtractedSchema | undefined): Finding | undefined {
	/* a CREATE TABLE AS holds its target as a plain field, not a typed node */
	const relation =
		type === "CreateStmt"
			? node["relation"]
			: type === "ViewStmt"
				? node["view"]
				: type === "CreateTableAsStmt"
					? (node["into"] as Node)["rel"]
					: undefined
	const table = relation === undefined ? undefined : tableOf(relation)
	if (table?.temp === true && before?.tables.has(table.name) === true)
		return { level: "unsafe", note: `shadows ${table.name} for the rest of the file` }
	return undefined
}

/** One Postgres statement's findings, read from its parse tree */
function pgTreeFindings(stmt: string, ctx: { before?: ExtractedSchema | undefined; fresh: Fresh }): Finding[] {
	const parser = postgresParser()
	let tree: { stmts?: unknown }
	try {
		tree = parser.parseSync(stmt)
	} catch (error) {
		// reason: a statement Postgres cannot parse is the statement's finding, unsafe
		return [{ level: "unsafe", note: `comb could not parse this as Postgres 17: ${(error as Error).message}` }]
	}
	return nodesOf(tree.stmts).flatMap(([type, node]) =>
		/^(?:InsertStmt|UpdateStmt|DeleteStmt|MergeStmt)$/.test(type)
			? writeFindings(type, node, ctx)
			: [codeFinding(type, node, ctx.before)].filter((finding) => finding !== undefined),
	)
}

export { pgTreeFindings }
