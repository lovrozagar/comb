/**
 * The destructive-change gate. Each statement's code (sql-code.ts) is read per action, so a drop
 * after an `ADD` in one `ALTER TABLE` counts, and a name may be quoted or schema-qualified.
 *
 * unsafe: loses data or breaks deployed code by name (table, column, schema, type, sequence,
 * role drops; CASCADE; retypes; SET NOT NULL; a NOT NULL column without a default; renames;
 * TRUNCATE; DELETE or UPDATE without a top-level WHERE). cautious: drops nothing a row holds
 * (indexes, constraints, views, policies, triggers, functions, defaults), a filtered write, a
 * grant, or a file Atlas runs outside a transaction. A lock warning names a statement that
 * blocks a Postgres table while it runs. A `DO` body runs, so its statements are read too.
 */
import type { Dialect, ExtractedSchema, MigrationClassification } from "../types.ts"
import { alterTableFindings, type Finding } from "./classify-alter.ts"
import { codeOf, lastPart, QNAME, splitTopLevel, topLevel, unquote } from "./sql-code.ts"
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"

type ClassifyOptions = {
	/** the schema the earlier migrations leave, which tells a lossless SQLite table rebuild from a drop */
	before?: ExtractedSchema | undefined
	/** how the file is read; unnamed, it is read both ways and the stricter finding counts */
	dialect?: Dialect | undefined
}

/** What the statements of one file show, read once before the rules run */
type FileContext = { before: ExtractedSchema | undefined; created: Set<string>; dialect: Dialect; rebuilds: Rebuilds }

/** A SQLite rebuild of `table`: the temporary table it is copied into, and the columns copied */
type Rebuilds = Map<string, { columns: string[]; temp: string }>

const UNSAFE_DROP =
	/^DROP (?:TABLE|SCHEMA|SEQUENCE|MATERIALIZED VIEW|EXTENSION|DOMAIN|DATABASE|TYPE|ROLE|USER|GROUP|OWNED|FOREIGN TABLE)\b/i
// per-process-constant: a pattern composed from the name grammar, compiled once
const DROP_LIST = /* @__PURE__ */ new RegExp(
	`^DROP (TABLE|INDEX) (?:CONCURRENTLY )?(?:IF EXISTS )?(${QNAME}(?:\\s*,\\s*${QNAME})*)`,
	"i",
)
const VOLATILE_WRITE = /^(?:WITH\b.*?\b)?(DELETE|UPDATE)\b(.*)$/i
const CAUTIOUS =
	/^(?:DROP|GRANT|REVOKE|CALL|CREATE OR REPLACE|ALTER SEQUENCE \S+ RESTART|ALTER (?:INDEX|POLICY|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE)\b.*\bRENAME)\b/i
const RENAMES_NAMED = /^ALTER (?:TYPE|SCHEMA|VIEW|MATERIALIZED VIEW) \S+ (?:RENAME|SET SCHEMA|DROP ATTRIBUTE)\b/i
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
// per-process-constant: a pattern composed from the name grammar, compiled once
const COPY_INTO = /* @__PURE__ */ new RegExp(`^INSERT INTO (${QNAME}) \\(([^)]*)\\) SELECT\\b.* FROM (${QNAME})`, "i")
// per-process-constant: a pattern composed from the name grammar, compiled once
const RENAME_TABLE = /* @__PURE__ */ new RegExp(`^ALTER TABLE (${QNAME}) RENAME TO (${QNAME})$`, "i")
const LOCKING = /^(?:REINDEX (?!.*\bCONCURRENTLY\b)|VACUUM FULL\b|CLUSTER\b)/i
const TXMODE_NONE = /^\s*--\s*atlas:txmode\s+none\b/im

/** A statement as a person reads it in a prompt: comments and layout gone, cut at 80 characters */
function preview(stmt: string): string {
	const text = normalizeSql(stmt)
	return text.slice(0, 80) + (text.length > 80 ? "..." : "")
}

/** The drops a DROP TABLE or DROP INDEX names, one per listed name */
function dropNames(code: string): string[] {
	const [, kind, list] = DROP_LIST.exec(code) ?? []
	if (kind === undefined || list === undefined) return []
	return splitTopLevel(list).map((name) => `DROP ${kind.toUpperCase()} ${unquote(name)}`)
}

/** A DELETE, UPDATE or MERGE: unsafe without a top-level WHERE (or with a MERGE delete), else cautious */
function writeFinding(code: string): Finding | undefined {
	if (/^MERGE\b/i.test(code)) return { level: /\bTHEN DELETE\b/i.test(code) ? "unsafe" : "cautious" }
	const write = VOLATILE_WRITE.exec(topLevel(code))
	if (write === undefined || write === null) return undefined
	return { level: /\bWHERE\b/i.test(write[2] as string) ? "cautious" : "unsafe" }
}

/** A SQLite drop that is a table rebuild: lossless when it copies every column the table had */
function rebuildFinding(code: string, ctx: FileContext): Finding | undefined {
	const table = DROP_LIST.exec(code)?.[2]
	const rebuild = table === undefined ? undefined : ctx.rebuilds.get(lastPart(table))
	if (table === undefined || rebuild === undefined) return undefined
	const name = lastPart(table)
	const earlier = ctx.before?.tables.get(name)
	if (earlier === undefined) return { level: "unsafe", note: `rebuilds ${name}, whose earlier columns are unknown` }
	const lost = earlier.filter((column) => !rebuild.columns.includes(column))
	if (lost.length === 0) return { level: "cautious" }
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
	const findings: Finding[] = []
	if (UNSAFE_DROP.test(code) || /^TRUNCATE\b/i.test(code) || RENAMES_NAMED.test(code))
		findings.push({ drops: dropNames(code), level: "unsafe" })
	else if (CAUTIOUS.test(code)) findings.push({ drops: dropNames(code), level: "cautious" })
	if (/\bCASCADE\b/i.test(code.replace(/\bON (?:DELETE|UPDATE) CASCADE\b/gi, ""))) findings.push({ level: "unsafe" })
	const write = writeFinding(code)
	if (write !== undefined) findings.push(write)
	if (ctx.dialect === "postgres") {
		const index = indexWarning(code, ctx)
		if (index !== undefined) findings.push(index)
		if (LOCKING.test(code)) findings.push({ level: "lock", note: "holds an exclusive lock while it runs" })
	}
	return findings
}

/** The findings of one statement; a DO body's statements are read as the code they run */
function findingsOf(code: string, ctx: FileContext): Finding[] {
	if (/^DO\b/i.test(code)) return doFindings(code, ctx)
	const table = /^ALTER TABLE\b/i.test(code) ? alterTableFindings(code, ctx) : undefined
	return table ?? statementFindings(code, ctx)
}

/** A DO block: each statement of its body, control words stripped; EXECUTE runs SQL comb cannot read */
function doFindings(code: string, ctx: FileContext): Finding[] {
	const body = code.replace(/^DO (?:LANGUAGE \S+ )?/i, "")
	const statements = splitSqlStatements(body, "postgres").map((stmt) =>
		stmt.replace(/^(?:(?:BEGIN|ELSE|LOOP|THEN|DECLARE)\s+|(?:IF|ELSIF|WHEN)\b.*?\bTHEN\s+)*/i, ""),
	)
	const findings = statements.flatMap((stmt) => findingsOf(stmt, ctx))
	if (/\bEXECUTE\b/i.test(body)) findings.push({ level: "cautious" })
	return findings
}

/** The rebuilds a file makes: a copy into a temporary table renamed to the table it copied */
function rebuildsOf(codes: readonly string[]): Rebuilds {
	const copies = new Map<string, { columns: string[]; from: string }>()
	const rebuilds: Rebuilds = new Map()
	for (const code of codes) {
		const [, into, columns, from] = COPY_INTO.exec(code) ?? []
		if (into !== undefined && columns !== undefined && from !== undefined) {
			copies.set(lastPart(into), { columns: splitTopLevel(columns).map(lastPart), from: lastPart(from) })
		}
		const [, temp, to] = RENAME_TABLE.exec(code) ?? []
		const copy = temp === undefined ? undefined : copies.get(lastPart(temp))
		if (to !== undefined && copy !== undefined && copy.from === lastPart(to)) {
			rebuilds.set(copy.from, { columns: copy.columns, temp: lastPart(temp as string) })
		}
	}
	return rebuilds
}

type Read = { code: string; findings: Finding[]; stmt: string }

function readFile(sql: string, before: ExtractedSchema | undefined, dialect: Dialect): Read[] {
	const statements = splitSqlStatements(sql, dialect)
	const codes = statements.map((stmt) => codeOf(stmt, dialect))
	const rebuilds: Rebuilds = dialect === "sqlite" ? rebuildsOf(codes) : new Map()
	const created = new Set(
		codes.flatMap((code) => {
			const table = CREATE_TABLE.exec(code)?.[1]
			return table === undefined ? [] : [lastPart(table)]
		}),
	)
	const ctx: FileContext = { before, created, dialect, rebuilds }
	return statements.map((stmt, i) => ({
		code: codes[i] as string,
		findings: findingsOf(codes[i] as string, ctx),
		stmt,
	}))
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
	const unsafeStatements = [...new Set(entries(reads, "unsafe"))]
	const cautiousStatements = [...new Set(entries(reads, "cautious"))]
	if (TXMODE_NONE.test(sql)) cautiousStatements.push("-- atlas:txmode none: the file is not applied in one transaction")
	const safety = unsafeStatements.length > 0 ? "unsafe" : cautiousStatements.length > 0 ? "cautious" : "safe"
	return { cautiousStatements, lockWarnings: [...new Set(entries(reads, "lock"))], safety, unsafeStatements }
}

export { classifyMigration, type ClassifyOptions, extractDropStatements }
