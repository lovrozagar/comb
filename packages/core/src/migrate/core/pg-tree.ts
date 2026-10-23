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
import { type Facts, followTree, keyOf, names, nodesOf, tableOf } from "./pg-history.ts"
import { postgresParser } from "./pg-parser.ts"
import { followParentage, reachFindings, useFinding } from "./pg-reach.ts"

type Node = Record<string, unknown>

/** What the walk reads a statement against: the history, what it and the file so far attached and defined, and what the file made fresh */
type TreeContext = {
	before?: ExtractedSchema | undefined
	/** what the history and the file so far attached to their tables (pg-history.ts) */
	facts: Facts
	fresh: Fresh
}

// lookup-table: the settings whose change decides what a later statement runs, and why
const SETTINGS: Readonly<Record<string, string>> = {
	search_path: "sets search_path, which decides the function or table every later unqualified name resolves to",
	session_replication_role: "sets session_replication_role, which can turn off triggers and foreign-key checks",
	role: 'sets the role, which changes the schemas "$user" puts on the search path and what later names resolve to',
	session_authorization:
		'sets the session user, which changes the schemas "$user" puts on the search path and what later names resolve to',
}
/** The columns a SET list assigns */
const assigned = (targets: unknown): string[] =>
	(targets as Array<{ ResTarget: { name: string } }>).map((target) => target.ResTarget.name)

/** An UPDATE's or upsert's rating: cautious when it backfills only what `fresh` holds, which it then takes out */
function updateFinding(table: { key: string; name: string }, columns: string[], fresh: Fresh): Finding {
	const added = fresh.columns.get(table.key)
	const backfill =
		fresh.tables.has(table.key) || (columns.length > 0 && columns.every((column) => added?.has(column) === true))
	for (const column of columns) added?.delete(column)
	return backfill
		? { level: "cautious", note: `backfills ${table.key} (${columns.join(", ")}), new in this file` }
		: { level: "unsafe", note: `updates existing rows of ${table.key} (${columns.join(", ")})` }
}

/** A write node's findings: its own rating, and what it runs on every table it reaches */
function writeFindings(type: string, node: Node, ctx: TreeContext): Finding[] {
	const table = tableOf(node["relation"])
	/* a write without ONLY reaches the table's partitions and inheritance children */
	const target = { inh: (node["relation"] as { inh?: boolean }).inh === true, key: table.key }
	if (type === "DeleteStmt")
		return [{ level: "unsafe", note: `deletes rows of ${table.key}` }, ...reachFindings(target, ["delete"], ctx)]
	if (type === "UpdateStmt")
		return [updateFinding(table, assigned(node["targetList"]), ctx.fresh), ...reachFindings(target, ["update"], ctx)]
	if (type === "MergeStmt") {
		const commands = (node["mergeWhenClauses"] as Array<{ MergeWhenClause: { commandType: string } }>).map(
			(each) => each.MergeWhenClause.commandType,
		)
		const changes = commands.some((command) => command === "CMD_UPDATE" || command === "CMD_DELETE")
		const events = commands.map((command) => command.replace("CMD_", "").toLowerCase())
		return [
			changes
				? { level: "unsafe", note: `merges into ${table.key}, updating or deleting its rows` }
				: { level: "cautious", note: `merges new rows into ${table.key}` },
			...reachFindings(target, events, ctx),
		]
	}
	const conflict = node["onConflictClause"] as Node | undefined
	if (conflict?.["action"] === "ONCONFLICT_UPDATE")
		return [
			updateFinding(table, assigned(conflict["targetList"]), ctx.fresh),
			...reachFindings(target, ["insert", "update"], ctx),
		]
	return reachFindings(target, ["insert"], ctx)
}

/** A SET, SET LOCAL or RESET of a setting that decides what later statements run: its finding */
function settingFinding(node: Node): Finding | undefined {
	if (node["kind"] === "VAR_RESET_ALL") return { level: "unsafe", note: "resets every setting, search_path among them" }
	const note = SETTINGS[String(node["name"])]
	return note === undefined ? undefined : { level: "unsafe", note }
}

/** A function or procedure the file creates: its finding, its name kept as one a migration defined */
function routineFinding(node: Node, ctx: TreeContext): Finding {
	const kind = node["is_procedure"] === true ? "procedure" : "function"
	const name = names(node["funcname"])
	ctx.facts.defined.add(keyOf(name))
	return { level: "unsafe", note: `creates ${kind} ${name.join(".")}, whose body comb does not read` }
}

/** A node that runs code comb does not read, changes what later names resolve to, or shadows a table: its finding */
function codeFinding(type: string, node: Node, ctx: TreeContext): Finding | undefined {
	if (type === "DoStmt") return { level: "unsafe", note: "runs a DO block, whose body comb does not read" }
	if (type === "CreateFunctionStmt") return routineFinding(node, ctx)
	if (type === "CreateTrigStmt")
		return {
			level: "unsafe",
			note: `creates trigger ${String(node["trigname"])}, which runs a function on later writes`,
		}
	if (type === "VariableSetStmt") return settingFinding(node)
	if (type === "FuncCall") return builtinFinding(names(node["funcname"]), ctx.facts.defined)
	/* a CALL holds its call as a plain field, not a typed node */
	if (type === "CallStmt") return builtinFinding(names((node["funccall"] as Node)["funcname"]), ctx.facts.defined)
	return useFinding(type, node, ctx.facts) ?? shadowFinding(type, node, ctx.before)
}

/** A temp table or view that takes an existing table's name: its finding */
function shadowFinding(type: string, node: Node, before: ExtractedSchema | undefined): Finding | undefined {
	/* a CREATE TABLE AS holds its target as a plain field, as SELECT … INTO does, not a typed node */
	const relation =
		type === "CreateStmt"
			? node["relation"]
			: type === "ViewStmt"
				? node["view"]
				: type === "CreateTableAsStmt"
					? (node["into"] as Node)["rel"]
					: (node["intoClause"] as Node | undefined)?.["rel"]
	const table = relation === undefined ? undefined : tableOf(relation)
	if (table?.temp === true && before?.tables.has(table.name) === true)
		return { level: "unsafe", note: `shadows ${table.name} for the rest of the file` }
	return undefined
}

/** One Postgres statement's findings, read from its parse tree */
function pgTreeFindings(stmt: string, ctx: TreeContext): Finding[] {
	const parser = postgresParser()
	let tree: { stmts?: unknown }
	try {
		tree = parser.parseSync(stmt)
	} catch (error) {
		// reason: a statement Postgres cannot parse is the statement's finding, unsafe
		return [{ level: "unsafe", note: `comb could not parse this as Postgres 17: ${(error as Error).message}` }]
	}
	const nodes = nodesOf(tree.stmts)
	const findings = nodes.flatMap(([type, node]) =>
		/^(?:InsertStmt|UpdateStmt|DeleteStmt|MergeStmt)$/.test(type)
			? writeFindings(type, node, ctx)
			: [codeFinding(type, node, ctx)].filter((finding) => finding !== undefined),
	)
	/* what the statement attached and reparented counts for the statements after it */
	for (const [type, node] of nodes) if (type === "AlterTableStmt") followParentage(node, ctx.fresh)
	followTree(tree.stmts, ctx.facts)
	return findings
}

export { pgTreeFindings, type TreeContext }
