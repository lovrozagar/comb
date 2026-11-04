/**
 * Which Postgres files may share one session (PA1 of r22b). Atlas runs one call's files on one
 * session, where what a file leaves in it (a SET, a role, a temp table, a held cursor) outlives its
 * COMMIT and reaches the next file. Only a file that changes the session leaks forward, so a run of
 * files where only the last may change it runs as each file alone would: apply gives each such run
 * one Atlas call, and the replay one session. A file may change the session when a statement:
 * - sets it: SET or RESET but SET LOCAL and SET TRANSACTION, set_config(…) without a literal true
 *   third argument, DISCARD, PREPARE, LISTEN, UNLISTEN, LOAD, a cursor declared WITH HOLD, a temp
 *   table, view or sequence;
 * - runs code comb cannot read: a DO block, a CALL, CREATE or ALTER EXTENSION, and a call it executes
 *   of a function comb does not know leaves the session as it was. That is a pg_catalog function
 *   CATALOG_CALLS names (pg-session-calls.ts), or a LANGUAGE sql function the files define whose
 *   body is one; an unqualified name is pg_catalog's when CATALOG_CALLS names it and no file defines
 *   a function or procedure by that name, as Postgres searches pg_catalog first while the search_path
 *   does not list it, and comb's never does. A function body, a view, a policy, a rule, a trigger and
 *   a CREATE TABLE's defaults and checks only store what they call; an ALTER TABLE's run on its rows;
 * - may run code a table holds (comb-9d's per-table ruling): a statement that reads or writes rows
 *   ends its run when a relation it names has a trigger, a rule other than a view's, a policy, or a
 *   default, generated column, check or index that calls a function outside pg_catalog, as the files
 *   and the server hold them. A flag carries from a partition or child to its parent, from a table
 *   to a view that reads it, from a table to the one its cascading foreign key references, and
 *   across a rename. A statement on rows that names no relation but a SELECT ends its run once any
 *   relation holds code;
 * - may run code no statement names: an operator, a cast, an operator class, an aggregate or a type
 *   the files define, a domain whose check or default calls a function outside pg_catalog, or an
 *   extension past plpgsql. Then every statement that reads or writes rows ends its run; an event
 *   trigger, which fires on DDL, ends every file's.
 * A file that calls currval or lastval reads what an earlier nextval of the session left, which no
 * file is held to end its run for, so it starts a run of its own.
 */
import { optionsOf } from "./pg-outside-transaction.ts"
import { names, type Node } from "./pg-nodes.ts"
import { callsOwn, closed, nodeOf, relationFacts, type Relations, relationsIn } from "./pg-session-tables.ts"
import { parsePostgres } from "./pg-parser.ts"
import { CATALOG_CALLS, READS_SESSION } from "./pg-session-calls.ts"
import { OPAQUE, ROWLESS, ROWLESS_COMMANDS, SETS, STORES } from "./pg-session-kinds.ts"
import { NO_SERVER_CODE, type ServerCode } from "./pg-server-code.ts"

/** What a file does to the session it runs on: whether it may change it, and whether it reads one an earlier file left */
type SessionUse = { changes: boolean; reads: boolean }

/** What every file defines that a statement's calls resolve against */
type Defined = {
	/** each function or procedure name a file defines, in any schema */
	names: ReadonlySet<string>
	/** the LANGUAGE sql functions whose bodies leave the session as it was */
	proven: ReadonlySet<string>
	/** whether the files or the server hold code a statement on rows may run without naming it */
	opaque: boolean
	/** whether the files or the server hold an event trigger, which runs on DDL */
	events: boolean
	/** each relation a statement on whose rows may run code, by its name in any schema */
	tables: ReadonlySet<string>
}

/* a DECLARE's option bit for WITH HOLD: a cursor kept past its transaction */
const CURSOR_OPT_HOLD = 0x20

/** Whether a relation a statement makes is temporary */
const temporary = (rel: unknown): boolean => {
	const relation = rel as { relpersistence?: string | undefined; schemaname?: string | undefined } | undefined
	return relation?.relpersistence === "t" || relation?.schemaname === "pg_temp"
}

/** Whether a statement of `type` sets the session from what it is, before its calls */
function setsByKind(type: string, node: Node): boolean {
	if (SETS.has(type)) return true
	if (type === "VariableSetStmt") return node["is_local"] !== true && node["name"] !== "TRANSACTION"
	if (type === "DeclareCursorStmt") return (Number(node["options"]) & CURSOR_OPT_HOLD) !== 0
	if (type === "CreateStmt" || type === "CreateSeqStmt") return temporary(node["relation"] ?? node["sequence"])
	if (type === "ViewStmt") return temporary(node["view"])
	if (type === "CreateTableAsStmt") return temporary((node["into"] as Node)["rel"])
	return false
}

/** The parts of a statement that run as it runs: none of one that only stores, an ALTER TABLE's but a new default */
function executed(type: string, node: Node): unknown {
	if (STORES.has(type)) return undefined
	if (type === "CreateTableAsStmt" && (node["into"] as Node)["skipData"] === true) return undefined
	if (type !== "AlterTableStmt") return node
	return (node["cmds"] as Array<{ AlterTableCmd: Node }>).filter(
		({ AlterTableCmd }) => AlterTableCmd["subtype"] !== "AT_ColumnDefault",
	)
}

/** Whether a statement of `type` reads or writes no rows */
function rowless(type: string, node: Node): boolean {
	if (type === "AlterTableStmt")
		return (node["cmds"] as Array<{ AlterTableCmd: Node }>).every(({ AlterTableCmd }) =>
			ROWLESS_COMMANDS.has(String(AlterTableCmd["subtype"])),
		)
	if (type === "CreateStmt") return node["partbound"] === undefined
	return ROWLESS.has(type)
}

/** Whether a statement on rows of `type` may run code: none it names, or a relation it names holds */
function runsCode(type: string, node: Node, defined: Defined): boolean {
	if (defined.opaque) return true
	const named = relationsIn(node)
	if (named.size === 0) return type !== "SelectStmt" && defined.tables.size > 0
	return [...named].some((name) => defined.tables.has(name))
}

/** Whether set_config's call `args` sets for the transaction alone: a literal true third argument */
const local = (args: unknown): boolean => {
	type Literal = { A_Const?: { boolval?: { boolval?: boolean | undefined } | undefined } | undefined }
	return (args as Array<Literal | undefined>)[2]?.A_Const?.boolval?.boolval === true
}

/** What one function call `call` does to the session, as `defined` resolves its name */
function callUse(call: Node, defined: Defined, use: SessionUse): void {
	const parts = names(call["funcname"])
	const name = parts.at(-1) as string
	const catalog = parts.length === 1 ? !defined.names.has(name) : parts[0] === "pg_catalog"
	if (catalog && name === "set_config") use.changes ||= !local(call["args"])
	else if (catalog && CATALOG_CALLS.has(name)) use.reads ||= READS_SESSION.has(name)
	else use.changes ||= !defined.proven.has(name)
}

/** Each function call in the tree `tree` folded into `use` */
function callsIn(tree: unknown, defined: Defined, use: SessionUse): void {
	if (tree === null || typeof tree !== "object") return
	const call = (tree as { FuncCall?: Node | undefined }).FuncCall
	if (call !== undefined) callUse(call, defined, use)
	for (const value of Object.values(tree)) callsIn(value, defined, use)
}

/** What the statement `tree` does to the session, `defined` resolving its calls */
function statementUse(tree: unknown, defined: Defined, use: SessionUse): void {
	const read = nodeOf(tree)
	if (read === undefined) {
		use.changes = true
		return
	}
	const [type, node] = read
	if (type === "CreateSchemaStmt") {
		for (const element of (node["schemaElts"] as unknown[] | undefined) ?? [])
			statementUse([{ stmt: element }], defined, use)
		return
	}
	use.changes ||= setsByKind(type, node) || defined.events || (!rowless(type, node) && runsCode(type, node, defined))
	callsIn(executed(type, node), defined, use)
}

/** What the statements `trees` do to the session */
function treesUse(trees: readonly unknown[], defined: Defined): SessionUse {
	const use = { changes: false, reads: false }
	for (const tree of trees) statementUse(tree, defined, use)
	return use
}

/** A function definition's name, and its LANGUAGE sql body's statement trees, none for another language or a body the parser cannot read */
function functionOf(node: Node): { body: unknown[] | undefined; name: string } {
	const name = names(node["funcname"]).at(-1) as string
	const options = optionsOf(node)
	if ((options.get("language") as { String?: { sval: string } | undefined } | undefined)?.String?.sval !== "sql")
		return { body: undefined, name }
	const atomic = node["sql_body"] as { List: { items: Array<{ List: { items: Node[] } }> } } | undefined
	if (atomic !== undefined)
		return { body: atomic.List.items.flatMap((item) => item.List.items.map((stmt) => [{ stmt }])), name }
	/* a LANGUAGE sql function without BEGIN ATOMIC holds its body as its one AS string */
	const [text] = (options.get("as") as { List: { items: [{ String: { sval: string } }] } }).List.items
	try {
		return {
			body: (parsePostgres(text.String.sval).stmts as unknown[]).map((stmt) => [stmt]),
			name,
		}
	} catch {
		// reason: a body Postgres's parser refuses is one comb cannot prove, read as code it cannot read
		return { body: undefined, name }
	}
}

/** What the files' trees and the server define, before their LANGUAGE sql bodies are proven */
function definitionsIn(trees: readonly unknown[], server: ServerCode) {
	const found = {
		all: new Set<string>(server.names),
		bodies: new Map<string, unknown[][]>(),
		events: server.events,
		opaque: server.opaque,
	}
	const unproven = new Set<string>()
	for (const tree of trees) {
		const [type, node] = nodeOf(tree) ?? ["", {}]
		if (type !== "CreateFunctionStmt") continue
		const { body, name } = functionOf(node)
		found.all.add(name)
		if (body === undefined) unproven.add(name)
		else found.bodies.set(name, [...(found.bodies.get(name) ?? []), body])
	}
	const relations: Relations = { carries: [...server.reaches], holds: new Set(server.tables) }
	const facts = { own: found.all, relations }
	for (const tree of trees) {
		const [type, node] = nodeOf(tree) ?? ["", {}]
		found.opaque ||=
			OPAQUE.has(type) || ((type === "CreateDomainStmt" || type === "AlterDomainStmt") && callsOwn(node, found.all))
		found.events ||= type === "CreateEventTrigStmt"
		relationFacts(tree, facts)
	}
	const proven = new Set([...found.bodies.keys()].filter((name) => !unproven.has(name)))
	return { ...found, proven, tables: closed(relations) }
}

/** What the files' trees and the server define that a call resolves against, LANGUAGE sql bodies proven to a fixed point */
function definedIn(trees: readonly unknown[], server: ServerCode): Defined {
	const { all, bodies, events, opaque, proven, tables } = definitionsIn(trees, server)
	const defined = { events, names: all, opaque, proven, tables }
	for (let changed = true; changed;) {
		changed = false
		for (const name of proven) {
			const uses = (bodies.get(name) as unknown[][]).map((body) => treesUse(body, defined))
			if (uses.some((use) => use.changes || use.reads)) {
				proven.delete(name)
				changed = true
			}
		}
	}
	return defined
}

/** A file as Postgres's parser read it: its statements' trees, none for a statement it cannot read */
type Read = { statements: ReadonlyArray<{ tree: unknown }> }

/** A file's statement trees */
const treesOf = (read: Read): unknown[] => read.statements.map((statement) => statement.tree)

/**
 * The `files`' runs that may share one session, in order, each ending at the first file that may
 * change it, or before a file that reads what an earlier one left; `context` is every file of the
 * directory, whose definitions resolve the calls (all of `files` by default), beside the `server`'s
 * code: its event trigger, its code no statement names, the tables it holds code on and the
 * relations a flag carries between, and its functions (comb-9d's rulings on PA1)
 */
function sessionRuns<T extends { read: Read }>(
	files: readonly T[],
	context: readonly { read: Read }[] = files,
	server: ServerCode = NO_SERVER_CODE,
): T[][] {
	const defined = definedIn([...server.trees, ...context.flatMap((file) => treesOf(file.read))], server)
	const runs: T[][] = []
	let open: T[] = []
	for (const file of files) {
		const use = treesUse(treesOf(file.read), defined)
		if (use.reads && open.length > 0) {
			runs.push(open)
			open = []
		}
		open.push(file)
		if (use.changes) {
			runs.push(open)
			open = []
		}
	}
	if (open.length > 0) runs.push(open)
	return runs
}

export { sessionRuns }
