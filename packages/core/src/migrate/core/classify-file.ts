/**
 * The file-level rules of the destructive-change gate: a statement Postgres runs only outside a
 * transaction is refused unless its file runs outside one, an external-content FTS5 index the
 * file creates again and rebuilds is known to lose nothing when it is dropped, and an FTS5 command
 * that removes indexed rows is unsafe.
 */
import type { Dialect } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import { INSERT_INTO } from "./classify-sqlite-write.ts"
import { nodeOf, outsideOnly } from "./pg-outside-transaction.ts"
import { atlasDirectives } from "./pg-split.ts"
import { nameKey, type Pragma, pragmaOf, QNAME } from "./sql-code.ts"
import { normalizeSql } from "./sql-scan.ts"

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
const FTS_ANY_COMMAND = /* @__PURE__ */ new RegExp(`${INSERT_INTO}(${QNAME}) ?\\( ?(${QNAME}) ?[,)]`, "i")
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
	const [, , into, column] = FTS_ANY_COMMAND.exec(sql) ?? []
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
/** A statement as the gate reads it: its code, its text, and on Postgres its parse tree, undefined where the parser refused it */
type ReadStatement = { code: string; dialect: Dialect; stmt: string; tree?: unknown }

/** SQLite's transaction control at the top of a file, but a rollback to a savepoint, which nests */
const SQLITE_TRANSACTION = /^(?:BEGIN|COMMIT|END|START TRANSACTION)\b|^ROLLBACK(?: TRANSACTION)?$/i

/** A truthy pragma value, as SQLite reads a boolean */
const ON = /^(?:on|true|yes|[1-9]\d*)$/i

/**
 * The pragmas SQLite refuses inside the transaction comb runs each file in, on every SQLite target
 * (bun:sqlite and libsql, .tmp/grunt/p18/tx-pragma-probe.log): which forms, and why
 */
const IN_TRANSACTION: Readonly<Record<string, { refuses: (pragma: Pragma) => boolean; why: string }>> = {
	journal_mode: {
		refuses: () => true,
		why: "journal_mode is the database's setting, and SQLite will not change it inside the transaction comb runs each file in; set it outside the migrations",
	},
	query_only: {
		refuses: ({ value }) => value !== undefined && ON.test(value),
		why: "query_only on makes the database read-only inside the transaction comb runs each file in, so the rest of the file and its history row fail; leave it out of the migrations",
	},
	synchronous: {
		refuses: ({ value }) => value !== undefined,
		why: "SQLite will not change the safety level inside the transaction comb runs each file in; set synchronous on the connection",
	},
	wal_checkpoint: {
		refuses: () => true,
		why: "a checkpoint cannot run inside the transaction comb runs each file in (libsql refuses it as locked); run it outside the migrations",
	},
}

/** The pragmas D1's authorizer runs in any form: Cloudflare's list (developers.cloudflare.com/d1/sql-api/sql-statements) */
// lookup-table: the names D1 authorizes, read on every pragma a D1 file runs
const D1_PRAGMAS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"case_sensitive_like",
	"defer_foreign_keys",
	"foreign_key_check",
	"foreign_key_list",
	"foreign_keys",
	"ignore_check_constraints",
	"index_info",
	"index_list",
	"index_xinfo",
	"legacy_alter_table",
	"quick_check",
	"recursive_triggers",
	"reverse_unordered_selects",
	"table_info",
	"table_list",
	"table_xinfo",
])

/** The pragmas D1 runs only as a read: optimize (Cloudflare refuses an argument), page_size and data_version (wrangler --local) */
// lookup-table: the names D1 runs as a read only
const D1_READS: ReadonlySet<string> = /* @__PURE__ */ new Set(["data_version", "optimize", "page_size"])

/** Why the target refuses `pragma` outright, or undefined when it runs it; on D1, also what D1 does not authorize */
function pragmaRefusal(pragma: Pragma, d1: boolean): string | undefined {
	const rule = IN_TRANSACTION[pragma.name]
	if (rule?.refuses(pragma) === true) return rule.why
	if (!d1 || D1_PRAGMAS.has(pragma.name) || (D1_READS.has(pragma.name) && pragma.value === undefined)) return undefined
	return `D1 runs only the pragmas it authorizes (developers.cloudflare.com/d1/sql-api/sql-statements), and wrangler's apply fails on this one with not authorized: SQLITE_AUTH; leave it out of the migrations`
}

/**
 * Refuses a statement that cannot run in its file `sql` on its target, a D1 database when `d1`: no
 * `-- comb:allow-unsafe:` overrides this
 */
function refuseUnrunnable({ code, dialect, stmt, tree }: ReadStatement, sql: string, d1 = false): void {
	if (dialect === "sqlite" && /^VACUUM\b/i.test(code)) {
		throw new Error(
			`${preview(stmt)}: VACUUM cannot run inside a migration's transaction; run it outside the migrations`,
		)
	}
	/* r18 S2 and r19 S1: a pragma the transaction or D1 refuses could never apply, so no approval clears it */
	const pragma = dialect === "sqlite" ? pragmaOf(code) : undefined
	const refusal = pragma === undefined ? undefined : pragmaRefusal(pragma, d1)
	if (refusal !== undefined) throw new Error(`${preview(stmt)}: ${refusal}`)
	/* S1 of the 0.15.0 review: the file's own BEGIN or COMMIT ends the batch that records it, so a
	   later failure leaves what ran before it committed with no history row, to run again */
	if (dialect === "sqlite" && SQLITE_TRANSACTION.test(code)) {
		throw new Error(
			`${preview(stmt)}: comb runs each file in a transaction of its own; remove the file's BEGIN, COMMIT, END and ROLLBACK (a SAVEPOINT nests inside it)`,
		)
	}
	/* P8 of r19: from the parse tree, so DETACH CONCURRENTLY, a bare CLUSTER and a REINDEX of a schema are caught too */
	const outside = tree === undefined ? undefined : outsideOnly(...nodeOf(tree))
	if (outside !== undefined && !outsideTransaction(sql)) {
		throw new Error(
			`${preview(stmt)}: Postgres runs ${outside} only outside a transaction; put it in a file of its own that starts with "-- atlas:txmode none" and a blank line`,
		)
	}
}

export { ftsCommandFindings, outsideTransaction, preview, type ReadStatement, refuseUnrunnable, reindexedOf }
