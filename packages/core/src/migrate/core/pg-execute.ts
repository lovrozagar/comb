/**
 * A Postgres EXECUTE read from its parse tree, as the pinned Atlas runs it (PA15 of r22b,
 * tests/integration/postgres/copy-execute-oracle.test.ts). Postgres runs an EXECUTE wherever it
 * stands, bare, under a CREATE TABLE AS or an EXPLAIN ANALYZE (AE2-2 of r22), so each is rated by
 * the query its file prepared under that name. comb's apply runs one Atlas call per file
 * (atlas-apply-runs.ts), so an earlier file's PREPARE never reaches it (AE2-9 of r22): one whose name
 * nothing before it in its file prepared fails the file, unless a statement before it ran user code,
 * which may PREPARE any name. A refusal is as sound as a rating, so comb refuses no file Postgres
 * runs: a DML statement fires triggers, a DDL statement fires event triggers (under a CREATE TABLE
 * AS, at ddl_command_start, before its EXECUTE's lookup), and a DO block, a CALL, a function call or
 * a resolved EXECUTE runs code of its own; only a PREPARE, a DEALLOCATE, a transaction statement, a
 * SET and a SHOW run none.
 */
import type { Finding } from "./classify-alter.ts"
import { kindOf, tagOf } from "./pg-events.ts"
import { names, type Node, nodesOf } from "./pg-nodes.ts"

/**
 * Every node of `stmts`, a statement's parse trees: a PREPARE as itself, never as the query it holds
 * (P21 of r19), and each EXECUTE followed by the nodes of the query `preparing` holds under its name.
 * A prepared query holds no PREPARE, so one level reads it whole
 */
const executedNodes = (
	stmts: ReadonlyArray<{ stmt: Node }>,
	preparing: ReadonlyMap<string, Node>,
): Array<[string, Node]> =>
	nodesOf(stmts.map((raw) => ("PrepareStmt" in raw.stmt ? { stmt: { PrepareStmt: {} } } : raw))).flatMap((entry) => {
		const query = entry[0] === "ExecuteStmt" ? preparing.get(String(entry[1]["name"])) : undefined
		return query === undefined ? [entry] : [entry, ...nodesOf(query)]
	})

/**
 * An ExecuteStmt `node`'s own findings: none when `preparing` holds its query, which executedNodes
 * rates; unsafe when `dynamic`, the file's first statement before it that may PREPARE, names one;
 * else a refusal, as Postgres fails the file
 */
function executeFindings(
	node: Node,
	{ dynamic, preparing }: { dynamic?: string | undefined; preparing: ReadonlyMap<string, Node> },
): Finding[] {
	const name = String(node["name"])
	if (preparing.has(name)) return []
	if (dynamic === undefined)
		throw new Error(
			`no statement before it in its file prepares ${name}, and comb applies each file in a session of its own, so an earlier file's PREPARE never reaches it: Postgres fails the file with "prepared statement "${name}" does not exist"; PREPARE it in this file`,
		)
	const note = `runs a prepared statement comb cannot read, which ${dynamic} before it may prepare; approve it in the file`
	return [{ level: "unsafe", note }]
}

/** The top-level statements that run no user code: a PREPARE runs its query only when an EXECUTE does */
const INERT = /^(?:Prepare|Deallocate|Transaction|VariableSet|VariableShow)Stmt$/

/** A command tag with its article: an INSERT, a CREATE TABLE */
const an = (kind: string): string => `${/^[AEIOU]/.test(kind) ? "an" : "a"} ${kind}`

/** The event trigger the first DDL statement of `tops`, a statement's, fires at ddl_command_start, named */
function firedBy(tops: ReadonlyArray<[string, Node]>): string | undefined {
	const ddl = tops.find(([type, node]) => tagOf(type, node) !== undefined)
	return ddl === undefined ? undefined : `an event trigger ${an(kindOf(...ddl))} fires`
}

/**
 * The user code a statement may run, which may PREPARE as it runs, named: of `nodes`, its own, a DO
 * block, a CALL or a function call; else what its first of `tops` that runs any is
 */
function dynamicOf(tops: ReadonlyArray<[string, Node]>, nodes: ReadonlyArray<[string, Node]>): string | undefined {
	const top = tops.find(([type]) => !INERT.test(type))
	if (top === undefined) return undefined
	for (const [type, node] of nodes) {
		if (type === "DoStmt") return "a DO block"
		/* a CALL holds its call as a plain field, not a typed node */
		if (type === "CallStmt") return `a CALL of ${names((node["funccall"] as Node)["funcname"]).join(".")}`
		if (type === "FuncCall") return `a call of ${names(node["funcname"]).join(".")}()`
	}
	if (top[0] === "ExecuteStmt") return `an EXECUTE of ${String(top[1]["name"])}`
	return firedBy([top]) ?? `user code ${an(kindOf(...top))} runs`
}

export { dynamicOf, executedNodes, executeFindings, firedBy }
