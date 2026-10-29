/**
 * Default-deny: the statement shapes comb rates on its own. A statement is rated by the rules only
 * when it is a shape this module recognizes; every other is unsafe, named, and approved in the file
 * or not at all. Four review rounds found SQL the rules never read rated safe, one construct at a
 * time (a trigger's RAISE, a temp table shadowing a real one, a function in a DEFAULT); a closed
 * list ends that class instead of chasing it.
 *
 * Recognized: tables, indexes, views, virtual tables, schemas, sequences, types, domains,
 * extensions and comments made; ALTER TABLE (its actions read by classify-alter.ts); the drops the
 * rules rate; grants; INSERT, UPDATE, DELETE, REPLACE, MERGE and SELECT; SET and RESET; the two
 * foreign-key pragmas; savepoints, and Postgres's transaction control (SQLite's is refused); ANALYZE, REINDEX, VACUUM and CLUSTER; CALL; policies
 * made, altered or dropped, which are cautious: a policy destroys no value, it changes which rows
 * a role sees, and it can be reversed. Not recognized, so unsafe: triggers, functions, procedures
 * and rules (made, replaced, altered or dropped), DO blocks, and every other pragma. The one trigger shape comb recognizes is
 * the one it writes: an external-content FTS5 table's sync trigger, whose body only inserts the
 * row's columns or the `'delete'` command into that table; its DROP, when the file makes it again.
 * What a recognized statement writes, shadows or fires is the engine's to read: SQLite's in the
 * proof run, Postgres's parser in pg-tree.ts.
 */
import type { Dialect, ExtractedSchema } from "../types.ts"
import type { Finding } from "./classify-alter.ts"
import { nameKey, type Naming, QNAME, unquote } from "./sql-code.ts"
import { normalizeSql } from "./sql-scan.ts"
import { SYNC_TRIGGER, syncTriggerOf } from "./fts-sync.ts"

/** What the grammar needs from the file: the schema before it, and the FTS sync triggers it makes */
type GrammarContext = {
	before: ExtractedSchema | undefined
	dialect: Dialect
	ftsTriggers: ReadonlySet<string>
	naming: Naming
}

const RECOGNIZED = [
	/^CREATE (?:UNIQUE )?INDEX\b/i,
	/^CREATE (?:(?:TEMP|TEMPORARY|UNLOGGED) )?TABLE\b/i,
	/^CREATE VIRTUAL TABLE\b/i,
	/^CREATE (?:OR REPLACE )?(?:(?:TEMP|TEMPORARY) )?(?:RECURSIVE )?VIEW\b/i,
	/^CREATE (?:MATERIALIZED VIEW|SCHEMA|SEQUENCE|TYPE|DOMAIN|EXTENSION)\b/i,
	/^COMMENT ON\b/i,
	/^ALTER (?:TABLE|INDEX|SEQUENCE|VIEW|MATERIALIZED VIEW|TYPE|SCHEMA|DOMAIN|EXTENSION)\b/i,
	/^DROP (?:TABLE|INDEX|VIEW|MATERIALIZED VIEW|SCHEMA|SEQUENCE|TYPE|DOMAIN|EXTENSION|DATABASE|ROLE|USER|GROUP|OWNED|FOREIGN TABLE)\b/i,
	/^(?:GRANT|REVOKE|TRUNCATE)\b/i,
	/^(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|SELECT|WITH|VALUES|CALL)\b/i,
	/^(?:SET|RESET)\b/i,
	/^PRAGMA (?:main\.)?(?:defer_foreign_keys|foreign_keys) ?= ?(?:on|off|true|false|0|1)$/i,
	/^(?:SAVEPOINT|RELEASE|ROLLBACK(?: TRANSACTION)? TO)\b/i,
	/^(?:ANALYZE|ANALYSE|REINDEX|VACUUM|CLUSTER)\b/i,
	/^(?:CREATE|ALTER|DROP) POLICY\b/i,
]

/* Postgres's transaction control, which an `-- atlas:txmode none` file runs; SQLite's is refused (classify-file.ts) */
const PG_TRANSACTION = /^(?:BEGIN|COMMIT|END|ROLLBACK|START TRANSACTION)\b/i

/* recognized, and cautious: an extension's install or upgrade script runs as the migrating role,
   and a new owner bypasses row level security (an ALTER TABLE's OWNER TO is classify-alter.ts's) */
const CAUTIOUS_SHAPES: ReadonlyArray<[RegExp, string]> = [
	[/^(?:CREATE|ALTER) EXTENSION\b/i, "runs the extension's script"],
	[/^ALTER (?!TABLE\b)(?:MATERIALIZED VIEW|\w+) \S+.* OWNER TO\b/i, "a new owner, who bypasses row level security"],
]

// per-process-constant: a pattern composed from the name grammar, compiled once
const FTS_EXTERNAL = /* @__PURE__ */ new RegExp(
	`^CREATE VIRTUAL TABLE (?:IF NOT EXISTS )?(${QNAME}) USING fts5\\(.*\\bcontent ?= ?'[^']+'`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const DROP_TRIGGER = /* @__PURE__ */ new RegExp(`^DROP TRIGGER (?:IF EXISTS )?(${QNAME})$`, "i")

/**
 * The sync triggers an external-content FTS5 table keeps, among a file's statements, by name: a
 * trigger whose every statement inserts the row's columns, or the `'delete'` command, into an
 * FTS5 table whose text lives in another table (one the history knows, or one the file makes)
 */
function ftsTriggersOf(
	statements: readonly string[],
	before: ExtractedSchema | undefined,
	naming: Naming,
): Set<string> {
	/* read with their literals, since the 'delete' command is one, and without comments */
	const codes = statements.map((statement) => normalizeSql(statement).replace(/;$/, ""))
	const fts = new Set(before?.externalFts ?? [])
	for (const code of codes) {
		const table = FTS_EXTERNAL.exec(code)?.[1]
		if (table !== undefined) fts.add(nameKey(table, naming))
	}
	const out = new Set<string>()
	for (const code of codes) {
		const name = syncTriggerOf(code, fts, naming)
		if (name !== undefined) out.add(name)
	}
	return out
}

/** Whether `code` is an FTS sync trigger the file makes, or the drop of one the file makes or the history left */
function isFtsSync(code: string, ctx: GrammarContext): boolean {
	const made = SYNC_TRIGGER.exec(code)?.[1]
	if (made !== undefined) return ctx.ftsTriggers.has(nameKey(made, ctx.naming))
	const dropped = DROP_TRIGGER.exec(code)?.[1]
	if (dropped === undefined) return false
	const key = nameKey(dropped, ctx.naming)
	return ctx.ftsTriggers.has(key) || (ctx.before?.triggers.some((t) => t.name === key && t.ftsSync) ?? false)
}

// per-process-constant: a pattern composed from the name grammar, compiled once
const POLICY = /* @__PURE__ */ new RegExp(
	`^(CREATE|ALTER|DROP) POLICY (?:IF EXISTS )?${QNAME} ON (${QNAME})(?:.*?(?<!\\bRENAME )\\bTO ((?:${QNAME}|CURRENT_USER|CURRENT_ROLE|SESSION_USER|PUBLIC)(?:, ?(?:${QNAME}|CURRENT_USER|CURRENT_ROLE|SESSION_USER|PUBLIC))*))?`,
	"i",
)

/** Why a policy statement is cautious: whose rows it changes, on which table; undefined for any other statement */
function policyNote(code: string): string | undefined {
	const [, verb, table, roles] = POLICY.exec(code) ?? []
	if (verb === undefined || table === undefined) return undefined
	/* a policy made without TO applies to every role; an altered or dropped one keeps the roles it had */
	const who = roles?.split(",").map((role) => unquote(role.trim())) ?? [/^CREATE$/i.test(verb) ? "public" : "its roles"]
	const sees = who.length > 1 || who[0] === "its roles" ? "see" : "sees"
	return `changes which rows ${who.join(", ")} ${sees} on ${unquote(table)}`
}

/** The first words of a statement comb does not recognize, as its reason names it, a TEMP or TEMPORARY left out */
function kindOf(code: string): string {
	return code
		.replace(/^(CREATE (?:OR REPLACE )?)(?:TEMP|TEMPORARY) /i, "$1")
		.split(" ")
		.slice(0, /^(?:CREATE|ALTER|DROP) OR REPLACE\b/i.test(code) ? 4 : 2)
		.join(" ")
}

/* the families default-deny rates unsafe by rule, whatever else comb reads of them: made, replaced, altered or dropped */
const DENIED =
	/^(?:(?:CREATE (?:OR REPLACE )?(?:(?:TEMP|TEMPORARY) )?(?:CONSTRAINT )?|ALTER |DROP )(TRIGGER|FUNCTION|PROCEDURE|RULE)\b|(DO)\b)/i

/**
 * Why comb rates an unrecognized statement unsafe: the rule, for a trigger or a routine, which
 * another reading may describe as well; else that it does not recognize it (S10, P16 of the 0.15.0 review)
 */
function unrecognized(code: string): string {
	/* a pragma comb does not write is rated by its own rule too (classify-runtime.ts), never "not recognized" */
	if (/^PRAGMA\b/i.test(code)) return "comb rates every pragma it does not write unsafe; approve it in the file"
	const [, family, block] = DENIED.exec(code) ?? []
	if (block !== undefined) return "comb rates every DO block unsafe; approve it in the file"
	if (family !== undefined) return `comb rates every ${family.toLowerCase()} change unsafe; approve it in the file`
	return `comb does not recognize ${kindOf(code)}; approve it in the file`
}

/** What the grammar makes of one top-level statement: nothing when comb recognizes it as it is */
function grammarFindings(statement: string, ctx: GrammarContext): Finding[] {
	/* an EXPLAIN is the statement it explains (ANALYZE runs it) */
	const code = statement.replace(/^EXPLAIN (?:\([^)]*\) )?(?:(?:ANALYZE|ANALYSE|VERBOSE) )*/i, "")
	const recognized = ctx.dialect === "postgres" ? [...RECOGNIZED, PG_TRANSACTION] : RECOGNIZED
	if (!recognized.some((shape) => shape.test(code)) && !isFtsSync(code, ctx))
		return [{ level: "unsafe", note: unrecognized(code) }]
	const policy = policyNote(code)
	/* a policy renamed keeps its roles and its predicate */
	if (policy !== undefined)
		return /^ALTER POLICY .* RENAME TO \S+$/i.test(code) ? [] : [{ level: "cautious", note: policy }]
	const cautious = CAUTIOUS_SHAPES.find(([shape]) => shape.test(code))
	return cautious === undefined ? [] : [{ level: "cautious", note: cautious[1] }]
}

export { ftsTriggersOf, type GrammarContext, grammarFindings }
