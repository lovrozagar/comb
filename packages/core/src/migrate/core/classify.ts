/**
 * The destructive-change gate. Each statement's code (sql-code.ts) is read per action, so a drop
 * after an `ADD` in one `ALTER TABLE` counts, and a name may be quoted or schema-qualified.
 *
 * unsafe: loses data or breaks deployed code by name (table, column, schema, type, sequence,
 * role drops; CASCADE; retypes; SET NOT NULL; a NOT NULL column without a default; renames;
 * TRUNCATE; DELETE or UPDATE without a top-level WHERE, or with one that is always true, at any
 * depth: in a CTE, a subquery or a rule). cautious: drops nothing a row holds (indexes,
 * constraints, views, policies, triggers, functions, defaults), a filtered write, a grant, a call
 * of a function a migration created, a SQLite REPLACE, or a file Atlas runs outside a transaction.
 * A lock warning names a statement that blocks a Postgres table while it runs. A `DO` body runs,
 * so its statements are read too, and so is the literal SQL it EXECUTEs. A statement Postgres
 * refuses inside a transaction is refused outright unless its file runs outside one.
 */
import type { Dialect, ExtractedSchema, MigrationClassification } from "../types.ts"
import { alterTableFindings, type Finding } from "./classify-alter.ts"
import { preview, type ReadStatement, refuseUnrunnable, reindexedOf } from "./classify-file.ts"
import { preparedOf, runtimeFindings } from "./classify-runtime.ts"
import { followAdds, type Fresh, freshStart, writeFindings } from "./classify-write.ts"
import { NO_TRANSACTION, type Rebuilds, rebuildsOf, TXMODE_NONE } from "./rebuild-copy.ts"
import { noGuards, readGuards } from "./rebuild-guard.ts"
import { codeOf, doBody, executedSql, lastPart, QNAME, splitTopLevel, unquote } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

type ClassifyOptions = {
	/** the schema the earlier migrations leave, which tells a lossless SQLite table rebuild from a drop */
	before?: ExtractedSchema | undefined
	/** how the file is read; unnamed, it is read both ways and the stricter finding counts */
	dialect?: Dialect | undefined
}

/** What the statements of one file show, read once before the rules run */
type FileContext = {
	/** a SQLite file Atlas runs outside a transaction, as `-- atlas:txmode none` asks */
	txmodeNone: boolean
	/** the columns the file has added so far and nothing has written since: a backfill may fill them */
	fresh: Fresh
	before: ExtractedSchema | undefined
	created: Set<string>
	dialect: Dialect
	/** the functions and procedures this file or an earlier one creates, unquoted */
	functions: Set<string>
	rebuilds: Rebuilds
	/** rebuilt tables others reference whose rebuild comb did not guard, with the tables their drop reaches */
	unguarded: Map<string, string[]>
	/** rebuilt tables comb guarded, with the tables whose rows the guard keeps */
	kept: Map<string, string[]>
	/** each rebuilt table's notes of the tables it leaves under new rowids */
	renumbered: Map<string, string[]>
	/** external-content FTS5 tables the file creates again and rebuilds from their content: a drop of one loses nothing */
	reindexed: Set<string>
	/** the statements the file prepares, by name, with the code each runs */
	prepared: Map<string, string>
}

const UNSAFE_DROP =
	/^DROP (?:TABLE|SCHEMA|SEQUENCE|MATERIALIZED VIEW|EXTENSION|DOMAIN|DATABASE|TYPE|ROLE|USER|GROUP|OWNED|FOREIGN TABLE)\b/i
// per-process-constant: a pattern composed from the name grammar, compiled once
const DROP_LIST = /* @__PURE__ */ new RegExp(
	`^DROP (TABLE|INDEX) (?:CONCURRENTLY )?(?:IF EXISTS )?(${QNAME}(?:\\s*,\\s*${QNAME})*)`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const CAUTIOUS = /* @__PURE__ */ new RegExp(
	`^(?:DROP|GRANT|REVOKE|CALL|CREATE OR REPLACE|REPLACE|INSERT OR REPLACE|ALTER SEQUENCE (?:IF EXISTS )?${QNAME} RESTART|ALTER (?:INDEX|POLICY|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE)\\b.*\\bRENAME)\\b`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const RENAMES_NAMED = /* @__PURE__ */ new RegExp(
	`^ALTER (?:TYPE|SCHEMA|VIEW|MATERIALIZED VIEW) (?:IF EXISTS )?${QNAME} (?:RENAME|SET SCHEMA|DROP ATTRIBUTE)\\b`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const CREATE_FUNCTION = /* @__PURE__ */ new RegExp(`^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE) (${QNAME})`, "i")
// per-process-constant: a pattern composed from the name grammar, compiled once
const CALLED = /* @__PURE__ */ new RegExp(`(${QNAME})\\s*\\(`, "g")
const EXPLAIN = /^EXPLAIN (?:\([^)]*\) )?(?:(?:ANALYZE|ANALYSE|VERBOSE) )*/i
// per-process-constant: a pattern composed from the name grammar, compiled once
const INDEX_ON = /* @__PURE__ */ new RegExp(
	`^CREATE (?:UNIQUE )?INDEX (?!CONCURRENTLY)(?:IF NOT EXISTS )?(?:${QNAME} )?ON (?:ONLY )?(${QNAME})`,
	"i",
)
// per-process-constant: a pattern composed from the name grammar, compiled once
const CREATE_TABLE = /* @__PURE__ */ new RegExp(
	`^CREATE (?:(?:TEMP|TEMPORARY|UNLOGGED) )?TABLE (?:IF NOT EXISTS )?(${QNAME})`,
	"i",
)
const LOCKING = /^(?:REINDEX (?!.*\bCONCURRENTLY\b)|VACUUM FULL\b|CLUSTER\b)/i

/** The drops a DROP TABLE or DROP INDEX names, one per listed name */
function dropNames(code: string): string[] {
	const [, kind, list] = DROP_LIST.exec(code) ?? []
	if (kind === undefined || list === undefined) return []
	return splitTopLevel(list).map((name) => `DROP ${kind.toUpperCase()} ${unquote(name)}`)
}

/** A top-level SELECT or PERFORM that calls a function a migration created: it runs code comb did not read */
function callFinding(code: string, ctx: FileContext): Finding | undefined {
	if (!/^(?:SELECT|PERFORM)\b/i.test(code)) return undefined
	const calls = [...code.matchAll(CALLED)].some((match) => ctx.functions.has(lastPart(match[1] as string)))
	return calls ? { level: "cautious", note: "calls a function a migration created" } : undefined
}

/** A SQLite drop that is a table rebuild: lossless when it copies every column the table had */
function rebuildFinding(code: string, ctx: FileContext): Finding | undefined {
	const table = DROP_LIST.exec(code)?.[2]
	const rebuild = table === undefined ? undefined : ctx.rebuilds.get(lastPart(table))
	if (table === undefined || rebuild === undefined) return undefined
	const name = lastPart(table)
	if (ctx.txmodeNone) return { level: "unsafe", note: `rebuilds ${name}: ${NO_TRANSACTION}` }
	const earlier = ctx.before?.tables.get(name)
	if (earlier === undefined) return { level: "unsafe", note: `rebuilds ${name}, whose earlier columns are unknown` }
	const reached = ctx.unguarded.get(name)
	if (reached !== undefined) {
		return {
			level: "unsafe",
			note: `rebuilds ${name} unguarded: its drop deletes or orphans the rows of ${reached.join(", ")}; let comb migrate diff write it`,
		}
	}
	if (rebuild.problem !== undefined) return { level: "unsafe", note: `rebuilds ${name}: ${rebuild.problem}` }
	const lost = earlier.filter((column) => !rebuild.columns.includes(column))
	const kept = ctx.kept.get(name)
	const renumbered = (ctx.renumbered.get(name) ?? []).map((note) => `; ${note}`).join("")
	if (lost.length === 0 && kept !== undefined)
		return { level: "cautious", note: `rebuilds ${name}; comb keeps the rows of ${kept.join(", ")}${renumbered}` }
	if (lost.length === 0) return { level: "cautious", note: `rebuilds ${name}, copying every column${renumbered}` }
	return {
		drops: lost.map((column) => `DROP COLUMN ${name}.${column}`),
		level: "unsafe",
		note: `rebuilds ${name} without ${lost.join(", ")}`,
	}
}

/** A CREATE INDEX that blocks writes to a table this file did not create */
function indexWarning(code: string, ctx: FileContext): Finding | undefined {
	const table = INDEX_ON.exec(code)?.[1]
	if (table === undefined || ctx.created.has(lastPart(table))) return undefined
	return {
		level: "lock",
		note: `blocks writes to ${unquote(table)} while it builds; use CREATE INDEX CONCURRENTLY in its own -- atlas:txmode none file`,
	}
}

/** The findings of one statement's code that are not ALTER TABLE actions */
function statementFindings(code: string, ctx: FileContext): Finding[] {
	const rebuild = rebuildFinding(code, ctx)
	if (rebuild !== undefined) return [rebuild]
	const dropped = DROP_LIST.exec(code)
	if (
		dropped?.[1]?.toUpperCase() === "TABLE" &&
		splitTopLevel(dropped[2] as string).every((t) => ctx.reindexed.has(lastPart(t)))
	) {
		return [{ level: "cautious", note: "an FTS index comb rebuilds from its content table" }]
	}
	const findings: Finding[] = []
	if (UNSAFE_DROP.test(code) || /^TRUNCATE\b/i.test(code) || RENAMES_NAMED.test(code))
		findings.push({ drops: dropNames(code), level: "unsafe" })
	else if (CAUTIOUS.test(code)) findings.push({ drops: dropNames(code), level: "cautious" })
	if (/\bCASCADE\b/i.test(code.replace(/\bON (?:DELETE|UPDATE) CASCADE\b/gi, ""))) findings.push({ level: "unsafe" })
	findings.push(
		...writeFindings(code, ctx.fresh),
		...runtimeFindings(code, ctx.prepared, (body) => findingsOf(body, body, ctx)),
	)
	const call = callFinding(code, ctx)
	if (call !== undefined) findings.push(call)
	if (ctx.dialect === "postgres") {
		const index = indexWarning(code, ctx)
		if (index !== undefined) findings.push(index)
		if (LOCKING.test(code)) findings.push({ level: "lock", note: "holds an exclusive lock while it runs" })
	}
	return findings
}

/**
 * The findings of one statement, given its code and its text; a DO body's statements are read as
 * the code they run, and an EXPLAIN as the statement it explains (ANALYZE runs it)
 */
function findingsOf(code: string, stmt: string, ctx: FileContext): Finding[] {
	if (/^DO\b/i.test(code)) return doFindings(stmt, ctx)
	if (EXPLAIN.test(code)) return findingsOf(code.replace(EXPLAIN, ""), stmt, ctx)
	const table = /^ALTER TABLE\b/i.test(code) ? alterTableFindings(code, ctx) : undefined
	return table ?? statementFindings(code, ctx)
}

/**
 * A DO block: each statement of its body, control words stripped, and the literal SQL it
 * EXECUTEs; any other EXECUTE runs SQL comb cannot read
 */
function doFindings(stmt: string, ctx: FileContext): Finding[] {
	const body = doBody(stmt)
	const read = (sql: string) =>
		splitSqlStatements(sql, "postgres").flatMap((part) => {
			const code = codeOf(part, "postgres").replace(
				/^(?:(?:BEGIN|ELSE|LOOP|THEN|DECLARE)\s+|(?:IF|ELSIF|WHEN)\b.*?\bTHEN\s+)*/i,
				"",
			)
			return findingsOf(code, part, ctx)
		})
	const findings = [...read(body), ...executedSql(body).flatMap(read)]
	if (/\bEXECUTE\b/i.test(codeOf(body, "postgres"))) findings.push({ level: "cautious" })
	return findings
}

type Read = ReadStatement & { findings: Finding[] }

function readFile(sql: string, before: ExtractedSchema | undefined, dialect: Dialect): Read[] {
	const statements = splitSqlStatements(sql, dialect)
	const codes = statements.map((stmt) => codeOf(stmt, dialect))
	const rebuilds: Rebuilds = dialect === "sqlite" ? rebuildsOf(statements, codes) : new Map()
	const created = new Set(
		codes.flatMap((code) => {
			const table = CREATE_TABLE.exec(code)?.[1]
			return table === undefined ? [] : [lastPart(table)]
		}),
	)
	const functions = new Set([
		...(before?.functions ?? []),
		...codes.flatMap((code) => {
			const name = CREATE_FUNCTION.exec(code)?.[1]
			return name === undefined ? [] : [lastPart(name)]
		}),
	])
	const guards = dialect === "sqlite" ? readGuards(statements, codes, before) : noGuards()
	const reindexed = dialect === "sqlite" ? reindexedOf(statements) : new Set<string>()
	const prepared = preparedOf(codes)
	const ctx: FileContext = {
		before,
		created,
		dialect,
		functions,
		fresh: freshStart(),
		txmodeNone: dialect === "sqlite" && TXMODE_NONE.test(sql),
		prepared,
		rebuilds,
		reindexed,
		kept: guards.kept,
		renumbered: guards.renumbered,
		unguarded: guards.unguarded,
	}
	return statements.map((stmt, i) => {
		/* comb's own guard around a rebuild, exactly as comb writes it, empties and refills; it loses nothing */
		const findings = guards.guarded.has(i) ? [] : findingsOf(codes[i] as string, stmt, ctx)
		followAdds(codes[i] as string, ctx.fresh)
		return { code: codes[i] as string, dialect, findings, stmt }
	})
}

/** The file as its dialect reads it; with none named, as both read it, so the stricter reading counts */
const readings = (sql: string, { before, dialect }: ClassifyOptions): Read[] =>
	dialect === undefined
		? [...readFile(sql, before, "sqlite"), ...readFile(sql, before, "postgres")]
		: readFile(sql, before, dialect)

const entries = (reads: readonly Read[], level: Finding["level"]) =>
	reads.flatMap(({ findings, stmt }) =>
		findings
			.filter((f) => f.level === level)
			.map((f) => (f.note === undefined ? preview(stmt) : `${preview(stmt)} (${f.note})`)),
	)

/** The table, column and index drops a migration makes, as `DROP TABLE t`, `DROP COLUMN t.c`, `DROP INDEX i` */
function extractDropStatements(sql: string, options: ClassifyOptions = {}): string[] {
	return [...new Set(readings(sql, options).flatMap(({ findings }) => findings.flatMap((f) => f.drops ?? [])))]
}

/** How destructive a migration is, which statements make it so, and which block a Postgres table */
function classifyMigration(sql: string, options: ClassifyOptions = {}): MigrationClassification {
	const reads = readings(sql, options)
	for (const read of reads) refuseUnrunnable(read, sql)
	const unsafeStatements = [...new Set(entries(reads, "unsafe"))]
	/* a statement is listed once, at the strictest level a finding gives it */
	const cautiousStatements = [...new Set(entries(reads, "cautious"))].filter((stmt) => !unsafeStatements.includes(stmt))
	if (TXMODE_NONE.test(sql)) cautiousStatements.push("-- atlas:txmode none: the file is not applied in one transaction")
	const safety = unsafeStatements.length > 0 ? "unsafe" : cautiousStatements.length > 0 ? "cautious" : "safe"
	return { cautiousStatements, lockWarnings: [...new Set(entries(reads, "lock"))], safety, unsafeStatements }
}

export { classifyMigration, type ClassifyOptions, extractDropStatements }
