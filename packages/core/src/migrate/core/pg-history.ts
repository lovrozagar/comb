/**
 * What the Postgres history attached to its tables, read from the parse tree of each statement
 * (pg-tree.ts walks a file against it): each table's parents, by partition or inheritance, and the
 * code a write to a table runs besides its triggers. That code is a function a DEFAULT, a CHECK,
 * a generated column, an index's expression or predicate, or a column's domain calls, a rule on
 * the table, or an implicit or assignment
 * cast to one of its columns' types; a table made LIKE another takes the other's. The functions
 * behind a migration's operators and casts are kept too, so a use of one is read as a call.
 */
import type { ExtractedSchema } from "../types.ts"
import { builtinFinding } from "./pg-builtins.ts"
import { postgresParser } from "./pg-parser.ts"

type Node = Record<string, unknown>

/** What the history attached to its tables, keyed as nameKey keys a Postgres name */
type Facts = {
	/** each type a migration's cast reaches, with the cast's function, and whether the cast is implicit or on assignment */
	casts: Map<string, { automatic: boolean; fn: string }>
	/** why a write to a table runs code: what it runs */
	code: Map<string, string>
	/** each table's column types */
	columnTypes: Map<string, Set<string>>
	/** each domain whose CHECK calls a function, with the function */
	domains: Map<string, string>
	/** each operator a migration defined, with its function */
	operators: Map<string, string>
	/** each table's parents, and whether it is their partition */
	parents: Map<string, Array<{ parent: string; partition: boolean }>>
}

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

/** A name's key, as nameKey keys a Postgres name: pg_catalog and public left out */
const keyOf = (parts: readonly string[]): string =>
	parts.filter((part, i) => (i < parts.length - 1 ? part !== "pg_catalog" && part !== "public" : true)).join(".")

/** A RangeVar's table: its bare name, its key, and whether it is temporary */
function tableOf(relation: unknown): { key: string; name: string; temp: boolean } {
	const rel = relation as { relname: string; relpersistence: string; schemaname?: string }
	const key = keyOf(rel.schemaname === undefined ? [rel.relname] : [rel.schemaname, rel.relname])
	return { key, name: rel.relname, temp: rel.relpersistence === "t" || rel.schemaname === "pg_temp" }
}

/** A type's key */
const typeOf = (typeName: unknown): string => keyOf(names((typeName as Node)["names"]))

/** The first function an expression calls that is no pure built-in, by name */
function callIn(expression: unknown, defined: ReadonlySet<string>): string | undefined {
	for (const [type, node] of nodesOf([expression])) {
		if (type !== "FuncCall") continue
		const name = names(node["funcname"])
		if (builtinFinding(name, defined) !== undefined) return keyOf(name)
	}
	return undefined
}

/** What the history is read into, and the functions migrations define */
type Reader = { defined: ReadonlySet<string>; facts: Facts }

/** A table's new column: its type, and the code its default, checks, generated value, domain or cast run */
function followColumn(table: string, column: Node, { defined, facts }: Reader): void {
	const type = typeOf(column["typeName"])
	facts.columnTypes.set(table, (facts.columnTypes.get(table) ?? new Set()).add(type))
	const constraints = (column["constraints"] as Node[] | undefined) ?? []
	const runs =
		constraints
			.map((each) => callIn((each["Constraint"] as Node)["raw_expr"], defined))
			.find((fn) => fn !== undefined) ??
		facts.domains.get(type) ??
		(facts.casts.get(type)?.automatic === true ? facts.casts.get(type)?.fn : undefined)
	if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
}

/** A CREATE TABLE: its parents, its columns, its checks, and what a table it is LIKE runs */
function followCreate(node: Node, reader: Reader): void {
	const { defined, facts } = reader
	const table = tableOf(node["relation"]).key
	const parents = ((node["inhRelations"] as Node[] | undefined) ?? []).map((each) => tableOf(each["RangeVar"]).key)
	if (parents.length > 0)
		facts.parents.set(
			table,
			parents.map((parent) => ({ parent, partition: node["partbound"] !== undefined })),
		)
	for (const element of (node["tableElts"] as Node[] | undefined) ?? []) {
		if (element["ColumnDef"] !== undefined) followColumn(table, element["ColumnDef"] as Node, reader)
		const check =
			element["Constraint"] === undefined ? undefined : callIn((element["Constraint"] as Node)["raw_expr"], defined)
		if (check !== undefined && !facts.code.has(table)) facts.code.set(table, check)
		const like =
			element["TableLikeClause"] === undefined
				? undefined
				: tableOf((element["TableLikeClause"] as Node)["relation"]).key
		const copied = like === undefined ? undefined : facts.code.get(like)
		if (copied !== undefined && !facts.code.has(table)) facts.code.set(table, copied)
	}
}

/** An ALTER TABLE: a partition attached, a parent inherited, a column, a default or a check added */
function followAlter(node: Node, reader: Reader): void {
	const { defined, facts } = reader
	const table = tableOf(node["relation"]).key
	for (const each of node["cmds"] as Node[]) {
		const cmd = each["AlterTableCmd"] as Node
		const def = cmd["def"] as Node
		if (cmd["subtype"] === "AT_AttachPartition") {
			const child = tableOf((def["PartitionCmd"] as Node)["name"]).key
			facts.parents.set(child, [...(facts.parents.get(child) ?? []), { parent: table, partition: true }])
		} else if (cmd["subtype"] === "AT_AddInherit") {
			facts.parents.set(table, [
				...(facts.parents.get(table) ?? []),
				{ parent: tableOf(def["RangeVar"]).key, partition: false },
			])
		} else if (cmd["subtype"] === "AT_AddColumn") followColumn(table, def["ColumnDef"] as Node, reader)
		else {
			const runs = callIn(def, defined)
			if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
		}
	}
}

/** A domain, an operator or a cast with the function it runs */
function followDefinition(type: string, node: Node, { defined, facts }: Reader): void {
	if (type === "CreateDomainStmt") {
		const runs = ((node["constraints"] as Node[] | undefined) ?? [])
			.map((each) => callIn((each["Constraint"] as Node)["raw_expr"], defined))
			.find((fn) => fn !== undefined)
		if (runs !== undefined) facts.domains.set(keyOf(names(node["domainname"])), runs)
	} else if (type === "DefineStmt" && node["kind"] === "OBJECT_OPERATOR") {
		/* Postgres refuses an operator without its function, named FUNCTION or PROCEDURE */
		const fn = (node["definition"] as Node[])
			.map((each) => each["DefElem"] as Node)
			.find((elem) => elem["defname"] === "function" || elem["defname"] === "procedure") as Node
		facts.operators.set(names(node["defnames"]).join("."), typeOf((fn["arg"] as Node)["TypeName"]))
	} else if (type === "CreateCastStmt" && node["func"] !== undefined) {
		const target = typeOf(node["targettype"])
		const automatic = node["context"] === "COERCION_IMPLICIT" || node["context"] === "COERCION_ASSIGNMENT"
		const fn = keyOf(names((node["func"] as Node)["objname"]))
		facts.casts.set(target, { automatic, fn })
		if (!automatic) return
		for (const [table, types] of facts.columnTypes)
			if (types.has(target) && !facts.code.has(table)) facts.code.set(table, fn)
	}
}

/** `facts` after one statement's parse tree; `defined` the functions migrations define */
function followTree(stmts: unknown, facts: Facts, defined: ReadonlySet<string>): void {
	const reader = { defined, facts }
	for (const [type, node] of nodesOf(stmts)) {
		if (type === "CreateStmt") followCreate(node, reader)
		else if (type === "AlterTableStmt") followAlter(node, reader)
		else if (type === "IndexStmt") {
			/* an index's expressions and a partial index's predicate run on every write to its table */
			const table = tableOf(node["relation"]).key
			const runs = callIn([node["indexParams"], node["whereClause"]], defined)
			if (runs !== undefined && !facts.code.has(table)) facts.code.set(table, runs)
		} else if (type === "RuleStmt") {
			const table = tableOf(node["relation"]).key
			if (!facts.code.has(table)) facts.code.set(table, `rule ${String(node["rulename"])}`)
		} else followDefinition(type, node, reader)
	}
}

// lru-cache: each history's facts, read once per schema object, released with it
const CACHE = /* @__PURE__ */ new WeakMap<ExtractedSchema, Facts>()

/** What `before`'s history attached to its tables: a copy the file's own statements then follow */
function historyFacts(before: ExtractedSchema | undefined): Facts {
	const empty: Facts = {
		casts: new Map(),
		code: new Map(),
		columnTypes: new Map(),
		domains: new Map(),
		operators: new Map(),
		parents: new Map(),
	}
	if (before === undefined) return empty
	let facts = CACHE.get(before)
	if (facts === undefined) {
		facts = empty
		const defined = new Set(before.functions)
		for (const statement of before.statements) {
			let tree: { stmts?: unknown }
			try {
				tree = postgresParser().parseSync(statement)
			} catch {
				// reason: a history statement Postgres cannot parse attached nothing comb can read; the walk goes on
				continue
			}
			followTree(tree.stmts, facts, defined)
		}
		CACHE.set(before, facts)
	}
	return structuredClone(facts)
}

export { type Facts, followTree, historyFacts, keyOf, names, nodesOf, tableOf, typeOf }
