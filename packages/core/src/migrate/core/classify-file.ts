/**
 * The file-level rules of the destructive-change gate: a statement Postgres runs only outside a
 * transaction is refused unless its file runs outside one, an external-content FTS5 index the
 * file creates again and rebuilds is known to lose nothing when it is dropped, and an FTS5 command
 * that removes indexed rows is unsafe.
 */
import type { Dialect } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import { INSERT_INTO } from "./classify-sqlite-write.ts"
import { atlasHeader, outsideTransaction } from "./atlas-header.ts"
import { nameKey, type Pragma, pragmaOf, QNAME } from "./sql-code.ts"
import { type TargetKind, targetRefusal } from "./classify-target.ts"
import { blockAfter, nodeOf } from "./pg-outside-transaction.ts"
import { hashedSql, normalizeSql, segments } from "./sql-scan.ts"

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
	/* as written: a word written against a quoted name stays against it */
	const text = hashedSql(stmt)
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

/** A statement as the gate read it: its code, its text, and the dialect it was read as */
/** A statement as the gate reads it: its code, its text, and on Postgres its parse tree, undefined where the parser refused it */
/** A statement read: its code, its dialect, the statement, its parse tree, and what it is when Postgres runs it only outside a transaction, or only inside a block */
type ReadStatement = {
	code: string
	/** on Postgres, the BEGIN, COMMIT, ROLLBACK or PREPARE TRANSACTION the statement is */
	control?: string | undefined
	dialect: Dialect
	inside?: string | undefined
	/** on Postgres, the line, from 1, the statement starts on in its file */
	line?: number | undefined
	outside?: string | undefined
	stmt: string
	tree?: unknown
}

/** SQLite's transaction control at the top of a file, but a rollback to a savepoint, which nests */
const SQLITE_TRANSACTION = /^(?:BEGIN|COMMIT|END|START TRANSACTION)\b|^ROLLBACK(?: TRANSACTION)?$/i

/**
 * The pragmas SQLite refuses inside the transaction comb runs each file in, on every SQLite target
 * (bun:sqlite and libsql, .tmp/grunt/p18/tx-pragma-probe.log): which forms, and why
 */
const IN_TRANSACTION: Readonly<Record<string, { refuses: (pragma: Pragma) => boolean; why: string }>> = {
	journal_mode: {
		refuses: () => true,
		why: "journal_mode is the database's setting, and SQLite will not change it inside the transaction comb runs each file in; set it outside the migrations",
	},
	locking_mode: {
		refuses: ({ value }) => value !== undefined,
		why: "locking_mode EXCLUSIVE keeps the connection's lock on the database past the COMMIT of the transaction comb runs each file in, so the next file, comb's history and every other connection are locked out, and NORMAL changes nothing until then; leave it out of the migrations",
	},
	query_only: {
		refuses: ({ value }) => value !== undefined,
		why: "query_only on makes the database read-only inside the transaction comb runs each file in, so the rest of the file and its history row fail, and off does nothing on a connection comb opens; leave it out of the migrations",
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

/**
 * The pragmas whose setting is the process's, not the connection's: every connection reads it, other
 * databases' included, so the fresh connection each file applies on cannot end it, and it outlasts
 * the migration (.tmp/grunt/r21-premise/s1-heap.*.log; tests/structure/pragma-scope.test.ts asks the
 * running engines). A read of one is any other pragma.
 */
// lookup-table: the pragma names, fixed
const PROCESS_PRAGMAS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"hard_heap_limit",
	"soft_heap_limit",
	"temp_store_directory",
])

/** Why a file may not set a process's pragma */
const processWide = (name: string) =>
	`${name} is the process's setting: it reaches every connection, other databases' included, and outlives the file; set it where the application opens SQLite, outside the migrations`

/** Why every SQLite target refuses `pragma` outright, or undefined when it runs it */
function pragmaRefusal(pragma: Pragma): string | undefined {
	const rule = IN_TRANSACTION[pragma.name]
	if (rule?.refuses(pragma) === true) return rule.why
	if (PROCESS_PRAGMAS.has(pragma.name) && pragma.value !== undefined) return processWide(pragma.name)
	return undefined
}

/**
 * Refuses a statement that cannot run in its file `sql` on its target, of `kind`: no `-- comb:allow-unsafe:`
 * overrides this
 */
function refuseUnrunnable(
	{ code, control, dialect, inside, outside, stmt }: ReadStatement,
	sql: string,
	kind: TargetKind = "local",
): void {
	if (dialect === "sqlite" && /^VACUUM\b/i.test(code)) {
		throw new Error(
			`${preview(stmt)}: VACUUM cannot run inside a migration's transaction; run it outside the migrations`,
		)
	}
	/* r18 S2, r19 S1 and r22 S1: what the transaction, D1 or sqld refuses could never apply, so no approval clears it */
	const pragma = dialect === "sqlite" ? pragmaOf(code) : undefined
	const target = dialect === "sqlite" ? targetRefusal(code, pragma, kind) : undefined
	const refusal = target ?? (pragma === undefined ? undefined : pragmaRefusal(pragma))
	if (refusal !== undefined) throw new Error(`${preview(stmt)}: ${refusal}`)
	/* S1 of the 0.15.0 review: the file's own BEGIN or COMMIT ends the batch that records it, so a
	   later failure leaves what ran before it committed with no history row, to run again */
	if (dialect === "sqlite" && SQLITE_TRANSACTION.test(code)) {
		throw new Error(
			`${preview(stmt)}: comb runs each file in a transaction of its own; remove the file's BEGIN, COMMIT, END and ROLLBACK (a SAVEPOINT nests inside it)`,
		)
	}
	refuseOutOfScope({ control, inside, outside, stmt }, outsideTransaction(sql))
}

/**
 * Refuses a Postgres statement the transaction Atlas runs its file in, or the lack of one in a
 * txmode none file (`bare`), cannot hold
 */
function refuseOutOfScope(
	{ control, inside, outside, stmt }: Pick<ReadStatement, "control" | "inside" | "outside" | "stmt">,
	bare: boolean,
): void {
	/* PA2 of r22b: Atlas records the file in its transaction, which the file's own control would end */
	if (control !== undefined && !bare) {
		throw new Error(
			`${preview(stmt)}: Atlas runs this file in one transaction and records it there, so its own ${control} ends that transaction; to commit as you go, start the file with "-- atlas:txmode none" and a blank line`,
		)
	}
	/* P8 of r19: from the parse tree, so DETACH CONCURRENTLY, a bare CLUSTER and a REINDEX of a schema are caught too */
	if (outside !== undefined && !bare) {
		throw new Error(
			`${preview(stmt)}: Postgres runs ${outside} only outside a transaction; put it in a file of its own that starts with "-- atlas:txmode none" and a blank line`,
		)
	}
	/* PA13 of r22b: Atlas sends a txmode none file's statements bare, so Postgres refuses these there */
	if (inside !== undefined && bare) {
		throw new Error(
			`${preview(stmt)}: Postgres runs ${inside} only inside a transaction block ("${inside} can only be used in transaction blocks"), and Atlas sends a "-- atlas:txmode none" file's statements bare; put it between the file's own BEGIN and COMMIT, or in a file without the txmode line`,
		)
	}
}

/** The line `read`'s code starts on, past the comments a later statement of a chunk opens with */
function codeLine({ line = 1, stmt }: ReadStatement): number {
	let skipped = ""
	for (const { kind, text } of segments(stmt, "postgres")) {
		const lead = kind === "comment" ? text : (/^\s*/.exec(text)?.[0] as string)
		skipped += lead
		if (lead !== text) break
	}
	return line + skipped.split("\n").length - 1
}

// AE7 of r22
/**
 * Refuses a txmode none Postgres file that leaves the transaction it opens open at its end: Atlas
 * records the file after its last statement, in that transaction, and closing the connection rolls
 * back both, so apply would say the file ran with nothing of it kept
 */
function refuseOpenBlock(reads: readonly ReadStatement[], sql: string): void {
	if (!outsideTransaction(sql)) return
	let opener: { name: string; read: ReadStatement } | undefined
	for (const read of reads) {
		if (read.dialect !== "postgres" || read.tree === undefined) continue
		const [type, node] = nodeOf(read.tree)
		if (!blockAfter(opener !== undefined, type, node)) opener = undefined
		/* a BEGIN in an open block only warns; a COMMIT or ROLLBACK AND CHAIN opens the next */
		else if (opener === undefined || node["chain"] === true)
			opener = { name: `${read.control}${node["chain"] === true ? " AND CHAIN" : ""}`, read }
	}
	if (opener === undefined) return
	throw new Error(
		`the file's ${opener.name} at line ${codeLine(opener.read)} is never committed: Atlas records a "-- atlas:txmode none" file after its last statement, in the transaction still open, and closing the connection rolls back both; end it with COMMIT or ROLLBACK`,
	)
}

/**
 * Refuses a Postgres file whose header's txmode Atlas refuses, quoting Atlas (PA3 of r22b): apply
 * would stop at it before it runs a statement; no `-- comb:allow-unsafe:` overrides this
 */
function refuseHeader(sql: string, dialect: Dialect): void {
	const { txmode } = atlasHeader(sql)
	if (dialect !== "postgres" || typeof txmode === "string") return
	throw new Error(
		`Atlas refuses this file's txmode (${JSON.stringify(txmode.refused)}); write "-- atlas:txmode none" to run it outside a transaction, or leave the line out`,
	)
}

export {
	ftsCommandFindings,
	preview,
	PROCESS_PRAGMAS,
	type ReadStatement,
	refuseHeader,
	refuseOpenBlock,
	refuseUnrunnable,
	reindexedOf,
}
