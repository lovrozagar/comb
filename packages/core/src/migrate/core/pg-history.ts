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
import { followNames } from "./pg-names.ts"
import { type Facts, keyOf, names, type Node, nodesOf, tableOf, typeOf } from "./pg-nodes.ts"
import { postgresParser } from "./pg-parser.ts"

/** The first function an expression calls that is no pure built-in, by name */
function callIn(expression: unknown, { defined, schema }: Pick<Facts, "defined" | "schema">): string | undefined {
	for (const [type, node] of nodesOf([expression])) {
		if (type !== "FuncCall") continue
		const name = names(node["funcname"])
		if (builtinFinding(name, defined) !== undefined) return keyOf(name, schema)
	}
	return undefined
}

/** A table's new column: its type, and the code its default, checks, generated value, domain or cast run */
function followColumn(table: string, column: Node, facts: Facts): void {
	const type = typeOf(column["typeName"], facts.schema)
	facts.columnTypes.set(table, (facts.columnTypes.get(table) ?? new Set()).add(type))
	const constraints = (column["constraints"] as Node[] | undefined) ?? []
	const runs =
		constraints.map((each) => callIn((each["Constraint"] as Node)["raw_expr"], facts)).find((fn) => fn !== undefined) ??
		facts.domains.get(type) ??
		(facts.casts.get(type)?.automatic === true ? facts.casts.get(type)?.fn : undefined)
	if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
}

/** A CREATE TABLE: its parents, its columns, its checks, and what a table it is LIKE runs */
function followCreate(node: Node, facts: Facts): void {
	const table = tableOf(node["relation"], facts.schema).key
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
		} else if (cmd["subtype"] === "AT_AddColumn") followColumn(table, def["ColumnDef"] as Node, facts)
		else {
			const runs = callIn(def, facts)
			if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
		}
	}
}

/** A domain, an operator or a cast with the function it runs */
function followDefinition(type: string, node: Node, facts: Facts): void {
	if (type === "CreateDomainStmt") {
		const runs = ((node["constraints"] as Node[] | undefined) ?? [])
			.map((each) => callIn((each["Constraint"] as Node)["raw_expr"], facts))
			.find((fn) => fn !== undefined)
		if (runs !== undefined) facts.domains.set(keyOf(names(node["domainname"]), facts.schema), runs)
	} else if (type === "DefineStmt" && node["kind"] === "OBJECT_AGGREGATE") {
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

/** `facts` after one statement's parse tree, the functions it defines among them */
function followTree(stmts: unknown, facts: Facts): void {
	const defined = facts.defined
	for (const [type, node] of nodesOf(stmts)) {
		if (type === "CreateFunctionStmt") defined.add(keyOf(names(node["funcname"]), facts.schema))
		else if (followNames(type, node, facts)) continue
		else if (type === "CreateStmt") followCreate(node, facts)
		else if (type === "AlterTableStmt") followAlter(node, facts)
		else if (type === "IndexStmt") {
			/* an index's expressions and a partial index's predicate run on every write to its table */
			const table = tableOf(node["relation"], facts.schema).key
			const runs = callIn([node["indexParams"], node["whereClause"]], facts)
			if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
		} else if (type === "RuleStmt") {
			const table = tableOf(node["relation"], facts.schema).key
			if (!facts.code.has(table)) facts.code.set(table, `rule ${String(node["rulename"])}`)
		} else followDefinition(type, node, facts)
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
		domains: new Map(),
		operators: new Map(),
		parents: new Map(),
		schema,
		triggers: new Map(),
	}
	if (before === undefined) return empty
	const read = CACHE.get(before) ?? new Map<string, Facts>()
	CACHE.set(before, read)
	let facts = read.get(schema)
	if (facts === undefined) {
		facts = empty
		for (const statement of before.statements) {
			let tree: { stmts?: unknown }
			try {
				tree = postgresParser().parseSync(statement)
			} catch {
				// reason: a history statement Postgres cannot parse attached nothing comb can read; the walk goes on
				continue
			}
			followTree(tree.stmts, facts)
		}
		read.set(schema, facts)
	}
	return structuredClone(facts)
}

export { type Facts, followTree, historyFacts, keyOf, names, nodesOf, tableOf, typeOf }
