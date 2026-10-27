/**
 * What the Postgres history attached to its tables, read from the parse tree of each statement
 * (pg-tree.ts walks a file against it): each table's parents, by partition or inheritance, and the
 * code a write to a table runs besides its triggers. That code is a function a DEFAULT, a CHECK,
 * a generated column, an index's expression or predicate, or a column's domain calls, a rule on
 * the table, or an implicit or assignment
 * cast to one of its columns' types; a table made LIKE another takes the other's. The functions
 * behind a migration's operators and casts are kept too, so a use of one is read as a call. So are
 * each table's triggers, followed through renames, moves to another schema and drops, and every
 * function, procedure and aggregate a migration defined, under each name it ever had: a dropped
 * overload leaves others of its name, so a name once defined stays defined.
 */
import type { ExtractedSchema } from "../types.ts"
import { builtinFinding } from "./pg-builtins.ts"
import { followEventTrigger } from "./pg-events.ts"
import { followNames } from "./pg-names.ts"
import { type Facts, keyOf, names, type Node, nodesOf, tableOf, typeOf } from "./pg-nodes.ts"
import { parsePostgres } from "./pg-parser.ts"
import { historyTrees } from "./pg-split.ts"

/**
 * The first function an expression calls whose finding is unsafe, by name: code a write runs that
 * comb cannot read. A cautious call such as a default's nextval, which is what a serial does, is
 * no such code (M83).
 */
function callIn(expression: unknown, { defined, schema }: Pick<Facts, "defined" | "schema">): string | undefined {
	for (const [type, node] of nodesOf([expression])) {
		if (type !== "FuncCall") continue
		const name = names(node["funcname"])
		if (builtinFinding(name, { defined, schema })?.level === "unsafe") return keyOf(name, schema)
	}
	return undefined
}

/** What a value of `type` runs on its way into a column: its domain's CHECK, or an implicit or assignment cast */
const typeCode = (type: string, facts: Facts): string | undefined =>
	facts.domains.get(type) ?? (facts.casts.get(type)?.automatic === true ? facts.casts.get(type)?.fn : undefined)

/** A column of `table` of `column.type`, and what it runs: `column.runs` when given, else its type's code */
function followType(table: string, { runs, type }: { runs?: string | undefined; type: string }, facts: Facts): void {
	facts.columnTypes.set(table, (facts.columnTypes.get(table) ?? new Set()).add(type))
	const code = runs ?? typeCode(type, facts)
	if (code !== undefined && !facts.code.has(table)) facts.code.set(table, code)
}

/** A table's new column: its type, and the code its default, checks, generated value, domain or cast run */
function followColumn(table: string, column: Node, facts: Facts): void {
	facts.tables.set(table, (facts.tables.get(table) ?? new Set()).add(String(column["colname"])))
	const constraints = (column["constraints"] as Node[] | undefined) ?? []
	const runs = constraints
		.map((each) => callIn((each["Constraint"] as Node)["raw_expr"], facts))
		.find((fn) => fn !== undefined)
	followType(table, { runs, type: typeOf(column["typeName"], facts.schema) }, facts)
}

/** A CREATE TABLE: its parents, its columns, its checks, and what a table it is LIKE runs */
function followCreate(node: Node, facts: Facts): void {
	const table = tableOf(node["relation"], facts.schema).key
	facts.tables.set(table, new Set())
	const parents = ((node["inhRelations"] as Node[] | undefined) ?? []).map(
		(each) => tableOf(each["RangeVar"], facts.schema).key,
	)
	if (parents.length > 0)
		facts.parents.set(
			table,
			parents.map((parent) => ({ parent, partition: node["partbound"] !== undefined })),
		)
	for (const element of (node["tableElts"] as Node[] | undefined) ?? []) {
		if (element["ColumnDef"] !== undefined) followColumn(table, element["ColumnDef"] as Node, facts)
		const check =
			element["Constraint"] === undefined ? undefined : callIn((element["Constraint"] as Node)["raw_expr"], facts)
		if (check !== undefined && !facts.code.has(table)) facts.code.set(table, check)
		const like =
			element["TableLikeClause"] === undefined
				? undefined
				: tableOf((element["TableLikeClause"] as Node)["relation"], facts.schema).key
		const copied = like === undefined ? undefined : facts.code.get(like)
		if (copied !== undefined && !facts.code.has(table)) facts.code.set(table, copied)
	}
}

// lookup-table: what an ALTER TABLE trigger command makes of the triggers it names; ENABLE REPLICA fires only
// under session_replication_role = replica, which no migration runs with, so it is off as DISABLE is
const TRIGGER_STATES: Readonly<Record<string, { all: boolean; enabled: boolean }>> = {
	AT_DisableTrig: { all: false, enabled: false },
	AT_DisableTrigAll: { all: true, enabled: false },
	AT_DisableTrigUser: { all: true, enabled: false },
	AT_EnableAlwaysTrig: { all: false, enabled: true },
	AT_EnableReplicaTrig: { all: false, enabled: false },
	AT_EnableTrig: { all: false, enabled: true },
	AT_EnableTrigAll: { all: true, enabled: true },
	AT_EnableTrigUser: { all: true, enabled: true },
}

/** A trigger of `table` enabled or disabled, or all of them */
function followTriggerState(table: string, cmd: Node, facts: Facts): void {
	const { all, enabled } = TRIGGER_STATES[String(cmd["subtype"])] as { all: boolean; enabled: boolean }
	for (const trigger of facts.triggers.get(table) ?? [])
		if (all || trigger.name === cmd["name"]) trigger.enabled = enabled
}

/** An ALTER TABLE: a partition attached, a parent inherited, a column, a default or a check added */
function followAlter(node: Node, facts: Facts): void {
	const table = tableOf(node["relation"], facts.schema).key
	for (const each of node["cmds"] as Node[]) {
		const cmd = each["AlterTableCmd"] as Node
		const def = cmd["def"] as Node
		if (cmd["subtype"] === "AT_AttachPartition") {
			const child = tableOf((def["PartitionCmd"] as Node)["name"], facts.schema).key
			facts.parents.set(child, [...(facts.parents.get(child) ?? []), { parent: table, partition: true }])
		} else if (cmd["subtype"] === "AT_AddInherit") {
			facts.parents.set(table, [
				...(facts.parents.get(table) ?? []),
				{ parent: tableOf(def["RangeVar"], facts.schema).key, partition: false },
			])
		} else if (TRIGGER_STATES[String(cmd["subtype"])] !== undefined) followTriggerState(table, cmd, facts)
		else if (cmd["subtype"] === "AT_AddColumn") followColumn(table, def["ColumnDef"] as Node, facts)
		else if (cmd["subtype"] === "AT_DropColumn") facts.tables.get(table)?.delete(String(cmd["name"]))
		else if (cmd["subtype"] === "AT_AlterColumnType") {
			/* a column retyped to a domain runs the domain's CHECK on every later write (M73) */
			followType(table, { type: typeOf((def["ColumnDef"] as Node)["typeName"], facts.schema) }, facts)
		} else {
			const runs = callIn(def, facts)
			if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
		}
	}
}

/** A domain made or given a CHECK: the function it runs, on every column it types; whether `type` was one */
function followDomain(type: string, node: Node, facts: Facts): boolean {
	if (type === "CreateDomainStmt") {
		/* a domain over a domain runs its base domain's CHECK too (M73) */
		const runs =
			((node["constraints"] as Node[] | undefined) ?? [])
				.map((each) => callIn((each["Constraint"] as Node)["raw_expr"], facts))
				.find((fn) => fn !== undefined) ?? facts.domains.get(typeOf(node["typeName"], facts.schema))
		if (runs !== undefined) facts.domains.set(keyOf(names(node["domainname"]), facts.schema), runs)
		return true
	}
	if (type !== "AlterDomainStmt") return false
	/* a CHECK added later runs on every write to a column the domain already types (M73) */
	const domain = keyOf(names(node["typeName"]), facts.schema)
	const added = node["subtype"] === "C" ? ((node["def"] as Node)["Constraint"] as Node)["raw_expr"] : undefined
	const runs = callIn(added, facts)
	if (runs === undefined) return true
	if (!facts.domains.has(domain)) facts.domains.set(domain, runs)
	for (const [table, types] of facts.columnTypes)
		if (types.has(domain) && !facts.code.has(table)) facts.code.set(table, runs)
	return true
}

/** An operator, an aggregate or a cast with the function it runs */
function followDefinition(type: string, node: Node, facts: Facts): void {
	if (followDomain(type, node, facts)) return
	if (type === "DefineStmt" && node["kind"] === "OBJECT_AGGREGATE") {
		facts.defined.add(keyOf(names(node["defnames"]), facts.schema))
	} else if (type === "DefineStmt" && node["kind"] === "OBJECT_OPERATOR") {
		/* Postgres refuses an operator without its function, named FUNCTION or PROCEDURE */
		const fn = (node["definition"] as Node[])
			.map((each) => each["DefElem"] as Node)
			.find((elem) => elem["defname"] === "function" || elem["defname"] === "procedure") as Node
		facts.operators.set(
			keyOf(names(node["defnames"]), facts.schema),
			typeOf((fn["arg"] as Node)["TypeName"], facts.schema),
		)
	} else if (type === "CreateCastStmt" && node["func"] !== undefined) {
		const target = typeOf(node["targettype"], facts.schema)
		const automatic = node["context"] === "COERCION_IMPLICIT" || node["context"] === "COERCION_ASSIGNMENT"
		const fn = keyOf(names((node["func"] as Node)["objname"]), facts.schema)
		facts.casts.set(target, { automatic, fn })
		if (!automatic) return
		for (const [table, types] of facts.columnTypes)
			if (types.has(target) && !facts.code.has(table)) facts.code.set(table, fn)
	}
}

/** The parts of the column a view's target names, none for an expression */
const fields = (target: Node): Node[] =>
	(((target["val"] as Node | undefined)?.["ColumnRef"] as Node | undefined)?.["fields"] as Node[] | undefined) ?? []

/**
 * A view, with the one table or view its query reads and how its columns name that one's: what
 * Postgres can write through, a single relation in FROM and no set operation (M71)
 */
function followView(node: Node, facts: Facts): void {
	const query = (node["query"] as Node)["SelectStmt"] as Node | undefined
	const from = (query?.["fromClause"] as Node[] | undefined) ?? []
	const single = query?.["op"] === "SETOP_NONE" && from.length === 1 && from[0]?.["RangeVar"] !== undefined
	const base = single ? tableOf(from[0]?.["RangeVar"], facts.schema).key : undefined
	const targets = ((query?.["targetList"] as Node[] | undefined) ?? []).map((each) => each["ResTarget"] as Node)
	const columns = targets.some((target) => fields(target).some((field) => field["A_Star"] !== undefined))
		? "all"
		: new Map(
				targets.flatMap((target) => {
					const last = fields(target).at(-1)?.["String"] as { sval: string } | undefined
					return last === undefined ? [] : [[String(target["name"] ?? last.sval), last.sval] as [string, string]]
				}),
			)
	facts.views.set(tableOf(node["view"], facts.schema).key, { base, columns })
}

/** An index, a table made from a query, a view or a rule: `facts` after it; whether `type` was one */
function followRelation(type: string, node: Node, facts: Facts): boolean {
	if (type === "IndexStmt") {
		/* an index's expressions and a partial index's predicate run on every write to its table */
		const table = tableOf(node["relation"], facts.schema).key
		const runs = callIn([node["indexParams"], node["whereClause"]], facts)
		if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
	} else if (type === "CreateTableAsStmt" || (type === "SelectStmt" && node["intoClause"] !== undefined)) {
		/* a table made from a query: its columns are the query's, which these rules need not name */
		const into = (type === "CreateTableAsStmt" ? node["into"] : node["intoClause"]) as Node
		facts.tables.set(tableOf(into["rel"], facts.schema).key, new Set())
	} else if (type === "ViewStmt") followView(node, facts)
	else if (type === "CreatePolicyStmt" || type === "AlterPolicyStmt") {
		/* a policy's predicate runs for every role it applies to, forced or not: app roles rarely own the table (M73) */
		const table = tableOf(node["table"], facts.schema).key
		const runs = callIn([node["qual"], node["with_check"]], facts)
		if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
	} else if (type === "RuleStmt") {
		const table = tableOf(node["relation"], facts.schema).key
		if (!facts.code.has(table)) facts.code.set(table, `rule ${String(node["rulename"])}`)
	} else return false
	return true
}

/** `facts` after one statement's parse tree, the functions it defines among them */
function followTree(stmts: unknown, facts: Facts): void {
	const defined = facts.defined
	for (const [type, node] of nodesOf(stmts)) {
		if (type === "CreateFunctionStmt") defined.add(keyOf(names(node["funcname"]), facts.schema))
		else if (followEventTrigger(type, node, facts) || followNames(type, node, facts)) continue
		else if (type === "CreateStmt") followCreate(node, facts)
		else if (type === "AlterTableStmt") followAlter(node, facts)
		else if (!followRelation(type, node, facts)) followDefinition(type, node, facts)
	}
}

/** A history statement's parse tree; throws for one the parser cannot read */
function historyTree(statement: string): unknown {
	try {
		return parsePostgres(statement).stmts
	} catch (error) {
		/* what it defined or attached is unknown, so the facts after it are too (M75) */
		throw new Error(`comb could not read the history: ${JSON.stringify(statement)} (${(error as Error).message})`, {
			cause: error,
		})
	}
}

// lru-cache: each history's facts under each schema, read once per schema object, released with it
const CACHE = /* @__PURE__ */ new WeakMap<ExtractedSchema, Map<string, Facts>>()

/**
 * What `before`'s history attached to its tables, its names keyed under `schema`: a copy the file's
 * own statements then follow
 */
function historyFacts(before: ExtractedSchema | undefined, schema: string): Facts {
	const empty: Facts = {
		casts: new Map(),
		code: new Map(),
		columnTypes: new Map(),
		defined: new Set(),
		eventTriggers: new Map(),
		domains: new Map(),
		operators: new Map(),
		parents: new Map(),
		schema,
		tables: new Map(),
		triggers: new Map(),
		views: new Map(),
	}
	if (before === undefined) return empty
	const read = CACHE.get(before) ?? new Map<string, Facts>()
	CACHE.set(before, read)
	let facts = read.get(schema)
	if (facts === undefined) {
		facts = empty
		/* the trees extractSchema kept; a statement without one is parsed here, which fails for one the parser cannot read */
		const trees = historyTrees(before)
		for (const [i, statement] of before.statements.entries()) followTree(trees?.[i] ?? historyTree(statement), facts)
		read.set(schema, facts)
	}
	return structuredClone(facts)
}

export { type Facts, followTree, historyFacts, keyOf, names, nodesOf, tableOf, typeOf }
