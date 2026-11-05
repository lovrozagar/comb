/**
 * A Postgres EXECUTE read from its parse tree, as the pinned Atlas runs it (PA15 of r22b,
 * tests/integration/postgres/copy-execute-oracle.test.ts). Postgres runs an EXECUTE wherever it
 * stands, bare, under a CREATE TABLE AS or an EXPLAIN ANALYZE (AE2-2 of r22), so each is rated by
 * the query its file prepared under that name; one whose name the file has not prepared may run any
 * write an earlier file's PREPARE, or one a function ran, holds.
 */
import type { Finding } from "./classify-alter.ts"
import { type Node, nodesOf } from "./pg-nodes.ts"

const UNREAD: Finding = { level: "unsafe", note: "runs a prepared statement comb cannot read; approve it in the file" }

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

/** An ExecuteStmt `node`'s own findings: none when `preparing` holds its query, which executedNodes rates */
const executeFindings = (node: Node, preparing: ReadonlyMap<string, Node>): Finding[] =>
	preparing.has(String(node["name"])) ? [] : [UNREAD]

export { executedNodes, executeFindings }
