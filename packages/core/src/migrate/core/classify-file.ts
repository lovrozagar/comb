/**
 * The file-level rules of the destructive-change gate: a statement Postgres runs only outside a
 * transaction is refused unless its file runs outside one, an external-content FTS5 index the
 * file creates again and rebuilds is known to lose nothing when it is dropped, and an FTS5 command
 * that removes indexed rows is unsafe.
 */
import type { Dialect } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import { atlasDirectives } from "./pg-objects.ts"
import { nameKey, QNAME } from "./sql-code.ts"
import { normalizeSql } from "./sql-scan.ts"

/* Postgres runs these only outside a transaction block */
const NO_TRANSACTION =
	/^(?:CREATE (?:UNIQUE )?INDEX CONCURRENTLY|DROP INDEX CONCURRENTLY|REINDEX\b.*\bCONCURRENTLY\b|VACUUM\b)/i
// per-process-constant: a pattern composed from the name grammar, compiled once
const FTS_TABLE = /* @__PURE__ */ new RegExp(
	`^CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?(${QNAME}) USING fts5 ?\\((.*)\\)$`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const FTS_COMMAND = /* @__PURE__ */ new RegExp(
	`^INSERT INTO (${QNAME}) ?\\( ?(${QNAME}) ?\\) VALUES ?\\( ?'rebuild' ?\\)$`,
	"i",
)

// per-process-constant: a pattern composed from the name grammar, compiled once
const FTS_ANY_COMMAND = /* @__PURE__ */ new RegExp(`^INSERT INTO (${QNAME}) ?\\( ?(${QNAME}) ?[,)]`, "i")
/* one row of an FTS5 command that rebuilds, merges or checks an index, or sets one of its options, with its
   one number or string argument: none removes an indexed row */
const KEEPS_ROWS =
	/\) ?VALUES ?\( ?'(?:rebuild|optimize|merge|automerge|crisismerge|usermerge|deletemerge|pgsz|rank|integrity-check|secure-delete)' ?(?:, ?(?:-?\d+|'[^']*') ?)?\)$/i

/**
 * An FTS5 command, an insert into the table's own hidden column, that removes indexed rows
 * ('delete', 'delete-all') or whose command comb cannot read is unsafe. SQLite runs it as an
 * insert, so the proof's engine pass sees no deletion; the command is its value.
 */
function ftsCommandFindings(stmt: string): Finding[] {
	const sql = normalizeSql(stmt).replace(/ ?;$/, "")
	const [, into, column] = FTS_ANY_COMMAND.exec(sql) ?? []
	if (into === undefined || nameKey(into, "sqlite") !== nameKey(column as string, "sqlite") || KEEPS_ROWS.test(sql))
		return []
	return [
		{ level: "unsafe", note: `runs an FTS5 command on ${into} that removes indexed rows, or one comb cannot read` },
	]
}

/** A statement as a person reads it in a prompt: comments and layout gone, cut at 80 characters */
function preview(stmt: string): string {
	const text = normalizeSql(stmt)
	return text.slice(0, 80) + (text.length > 80 ? "..." : "")
}

/**
 * The external-content FTS5 tables a file creates and then rebuilds from their content table:
 * such a table holds only an index of rows kept elsewhere
 */
function reindexedOf(statements: readonly string[]): Set<string> {
	const created = new Set<string>()
	const out = new Set<string>()
	for (const stmt of statements) {
		const sql = normalizeSql(stmt)
		const [, table, args] = FTS_TABLE.exec(sql) ?? []
		if (table !== undefined && /\bcontent ?= ?'[^']+'/i.test(args as string)) created.add(nameKey(table, "sqlite"))
		const [, into, command] = FTS_COMMAND.exec(sql) ?? []
		if (
			into !== undefined &&
			nameKey(into, "sqlite") === nameKey(command as string, "sqlite") &&
			created.has(nameKey(into, "sqlite"))
		) {
			out.add(nameKey(into, "sqlite"))
		}
	}
	return out
}

/** Whether `sql` runs outside a transaction: it starts with `-- atlas:txmode none` and a blank line, which Atlas needs */
const outsideTransaction = (sql: string): boolean => {
	const head = atlasDirectives(sql)
	return /^--[ \t]*atlas:txmode[ \t]+none\b/im.test(head) && head.endsWith("\n\n")
}

/** A statement as the gate read it: its code, its text, and the dialect it was read as */
type ReadStatement = { code: string; dialect: Dialect; stmt: string }

/** Refuses a statement that cannot run in its file `sql`: no `-- comb:allow-unsafe:` overrides this */
function refuseUnrunnable({ code, dialect, stmt }: ReadStatement, sql: string): void {
	if (dialect === "sqlite" && /^VACUUM\b/i.test(code)) {
		throw new Error(
			`${preview(stmt)}: VACUUM cannot run inside a migration's transaction; run it outside the migrations`,
		)
	}
	if (dialect === "postgres" && NO_TRANSACTION.test(code) && !outsideTransaction(sql)) {
		throw new Error(
			`${preview(stmt)}: Postgres runs this only outside a transaction; put it in a file of its own that starts with "-- atlas:txmode none" and a blank line`,
		)
	}
}

export { ftsCommandFindings, preview, type ReadStatement, refuseUnrunnable, reindexedOf }
