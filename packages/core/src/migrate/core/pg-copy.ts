/**
 * A Postgres COPY read from its parse tree, as the pinned Atlas runs it
 * (tests/integration/postgres/copy-execute-oracle.test.ts). Atlas's driver cannot run a COPY with the
 * client's stream, FROM STDIN or TO STDOUT: the file fails with "driver: bad connection", so the
 * check refuses one. A COPY with a program runs it on the database server, and one TO a file writes
 * the server's file, so each is unsafe; a COPY FROM a server file loads rows into a table.
 */
import type { Finding } from "./classify-alter.ts"
import { flag, type Node } from "./pg-nodes.ts"

/** Why Atlas can never apply a COPY of `node` with the client's stream; undefined for any other statement */
function copyRefusal(type: string, node: Node): string | undefined {
	if (type !== "CopyStmt" || node["filename"] !== undefined) return undefined
	return flag(node["is_from"])
		? 'Atlas\'s driver cannot run COPY FROM STDIN, so the file could never apply (it fails with "driver: bad connection"); write the rows as INSERT … VALUES'
		: 'Atlas\'s driver cannot run COPY TO STDOUT, so the file could never apply (it fails with "driver: bad connection"); a migration sends its rows to no one, so leave it out'
}

/** A COPY's findings for what it reaches: a server program or file written, or the rows it loads */
function copyFindings(node: Node): Finding[] {
	/* one with the client's stream the check refuses (copyRefusal) */
	if (node["filename"] === undefined) return []
	if (flag(node["is_program"]))
		return [{ level: "unsafe", note: "runs a program on the database server as its operating-system user" }]
	if (!flag(node["is_from"])) return [{ level: "unsafe", note: "writes a file on the database server" }]
	return [{ level: "cautious", note: "loads rows into a table" }]
}

export { copyFindings, copyRefusal }
