/**
 * The destructive-change gate. Each statement's code (sql-code.ts) is read per action, so a drop
 * after an `ADD` in one `ALTER TABLE` counts, and a name may be quoted or schema-qualified.
 *
 * unsafe: loses data or breaks deployed code by name (table, column, schema, type, sequence,
 * role drops; CASCADE; retypes; SET NOT NULL; a NOT NULL column without a default; renames;
 * TRUNCATE; a statement comb does not recognize, a trigger or routine made or dropped among them).
 * cautious: drops nothing a row holds (indexes, constraints, views, policies, defaults), a grant, or
 * a file Atlas runs outside a transaction. A lock warning names a
 * statement that blocks a Postgres table while it runs. What a statement writes is read from the
 * engine: on SQLite by the proof run (proof-engine.ts), on Postgres from its parse tree
 * (pg-tree.ts), which also rates the code a statement runs: DO blocks, routines and function
 * calls. A statement Postgres refuses inside a transaction is refused outright unless its file
 * runs outside one.
 */
import type { Dialect, ExtractedSchema, MigrationClassification } from "../types.ts"
import { alterTableFindings, type Finding } from "./classify-alter.ts"
import { ftsCommandFindings, preview, type ReadStatement, refuseUnrunnable, reindexedOf } from "./classify-file.ts"
import { ftsTriggersOf, grammarFindings } from "./classify-grammar.ts"
import { sqliteWriteFindings } from "./classify-sqlite-write.ts"
import { type RebuildContext, rebuildFinding } from "./classify-rebuild.ts"
import { preparedOf, runtimeFindings } from "./classify-runtime.ts"
import { followAdds, type Fresh, freshStart } from "./classify-write.ts"
import { type Facts, historyFacts } from "./pg-history.ts"
import { pgTreeFindings } from "./pg-tree.ts"
import { extractSchema } from "./schema.ts"
import { type Rebuilds, rebuildsOf, TXMODE_NONE } from "./rebuild-copy.ts"
import { noGuards, readGuards } from "./guard-read.ts"
import { codeOf, nameKey, namingOf, QNAME, splitTopLevel, unquote } from "./sql-code.ts"
import { type PgRead, pgRead } from "./pg-split.ts"
import { splitSqlStatements } from "./sql-scan.ts"

type ClassifyOptions = {
	/** the schema the earlier migrations leave, which tells a lossless SQLite table rebuild from a drop */
	before?: ExtractedSchema | undefined
	/** how the file is read; unnamed, as SQLite, the CLI's default */
	dialect?: Dialect | undefined
	/** the Postgres schema the URLs' search_path names, where an unqualified name resolves; public unnamed (M72) */
	schema?: string | undefined
}

/** What the statements of one file show, read once before the rules run */
type FileContext = RebuildContext & {
	/** the columns the file has added so far and nothing has written since: a backfill may fill them */
	fresh: Fresh
	created: Set<string>
	/** what the Postgres history and the file so far attached to their tables (pg-history.ts) */
	facts: Facts
	/** the schema the history and the file so far leave, statement by statement */
	schema: ExtractedSchema
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
/* on Postgres, what CAUTIOUS names but the parse tree does not rate: drops and renames (M70) and restarts (M82) are pg-ddl.ts's */
// per-process-constant: a pattern composed from the name grammar, compiled once
const PG_CAUTIOUS = /* @__PURE__ */ new RegExp(`^(?:GRANT|REVOKE|CALL|CREATE OR REPLACE)\\b`, "i")
// per-process-constant: a pattern composed from the name grammar, compiled once
const RENAMES_NAMED = /* @__PURE__ */ new RegExp(
	`^ALTER (?:TYPE|SCHEMA|VIEW|MATERIALIZED VIEW) (?:IF EXISTS )?${QNAME} (?:RENAME|SET SCHEMA|DROP ATTRIBUTE)\\b`,
	"i",
)
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

/** A CREATE INDEX that blocks writes to a table this file did not create */
function indexWarning(code: string, ctx: FileContext): Finding | undefined {
	const table = INDEX_ON.exec(code)?.[1]
	if (table === undefined || ctx.created.has(nameKey(table, ctx.naming))) return undefined
	return {
		level: "lock",
		note: `blocks writes to ${unquote(table)} while it builds; use CREATE INDEX CONCURRENTLY in its own -- atlas:txmode none file`,
	}
}

/** Whether `code` drops only external-content FTS5 indexes the file creates again and rebuilds */
function dropsRebuiltIndex(code: string, ctx: FileContext): boolean {
	const dropped = DROP_LIST.exec(code)
	return (
		dropped?.[1]?.toUpperCase() === "TABLE" &&
		splitTopLevel(dropped[2] as string).every((t) => {
			const key = nameKey(t, ctx.naming)
			/* only a table whose text lives elsewhere is an index: a stored-content FTS5 table holds the only copy */
			return ctx.reindexed.has(key) && ctx.before?.externalFts.includes(key) === true
		})
	)
}

/** A SQLite statement's drop, rename or other destructive shape, read from its code */
function sqliteDropFindings(code: string): Finding[] {
	if (UNSAFE_DROP.test(code) || /^TRUNCATE\b/i.test(code) || RENAMES_NAMED.test(code))
		return [{ drops: dropNames(code), level: "unsafe" }]
	return CAUTIOUS.test(code) ? [{ drops: dropNames(code), level: "cautious" }] : []
}

/** What the parse tree leaves to a Postgres statement's code: a TRUNCATE, and the grants, calls and replacements */
function pgTextFindings(code: string): Finding[] {
	if (/^TRUNCATE\b/i.test(code)) return [{ level: "unsafe" }]
	return PG_CAUTIOUS.test(code) ? [{ level: "cautious" }] : []
}

/** The findings of one statement's code that are not ALTER TABLE actions */
function statementFindings(code: string, ctx: FileContext): Finding[] {
	const rebuild = rebuildFinding(DROP_LIST.exec(code)?.[2], ctx)
	if (rebuild !== undefined) return [rebuild]
	if (dropsRebuiltIndex(code, ctx))
		return [{ level: "cautious", note: "an FTS index comb rebuilds from its content table" }]
	const findings: Finding[] = ctx.dialect === "postgres" ? pgTextFindings(code) : sqliteDropFindings(code)
	if (/\bCASCADE\b/i.test(code.replace(/\bON (?:DELETE|UPDATE) CASCADE\b/gi, ""))) findings.push({ level: "unsafe" })
	findings.push(...runtimeFindings(code, ctx.prepared, (body) => findingsOf(body, ctx)))
	if (ctx.dialect === "postgres") {
		const index = indexWarning(code, ctx)
		if (index !== undefined) findings.push(index)
		if (LOCKING.test(code)) findings.push({ level: "lock", note: "holds an exclusive lock while it runs" })
	}
	return findings
}

/** The findings of one statement's code; an EXPLAIN as the statement it explains (ANALYZE runs it) */
function findingsOf(code: string, ctx: FileContext): Finding[] {
	if (EXPLAIN.test(code)) return findingsOf(code.replace(EXPLAIN, ""), ctx)
	if (!/^ALTER TABLE\b/i.test(code)) return statementFindings(code, ctx)
	/* on Postgres an ALTER TABLE is rated from its parse tree, command by command (pg-ddl.ts, M70) */
	return ctx.dialect === "postgres" ? [] : (alterTableFindings(code, ctx) ?? statementFindings(code, ctx))
}

type Read = ReadStatement & { findings: Finding[] }

/** The file read as `dialect` reads it, against `before`, a Postgres name keyed under `schema` */
function readFile(
	sql: string,
	{ before, dialect, schema }: { before: ExtractedSchema | undefined; dialect: Dialect; schema: string },
	read: PgRead | undefined,
): Read[] {
	const naming = namingOf(dialect, schema)
	/* on Postgres, the statements Postgres runs: Atlas's chunks read by its parser (M75), each tree kept */
	const statements = read === undefined ? splitSqlStatements(sql) : read.statements.map(({ text }) => text)
	const codes = statements.map((stmt) => codeOf(stmt, dialect))
	const created = new Set(
		codes.flatMap((code) => {
			const table = CREATE_TABLE.exec(code)?.[1]
			return table === undefined ? [] : [nameKey(table, naming)]
		}),
	)
	const guards = dialect === "sqlite" ? readGuards(statements, codes, before) : noGuards()
	const rebuilds: Rebuilds = dialect === "sqlite" ? rebuildsOf(statements, codes, guards.guarded) : new Map()
	const reindexed = dialect === "sqlite" ? reindexedOf(statements) : new Set<string>()
	const prepared = preparedOf(codes)
	const ftsTriggers = ftsTriggersOf(statements, before, naming)
	const ctx: FileContext = {
		before,
		created,
		dialect,
		facts: historyFacts(dialect === "postgres" ? before : undefined, schema),
		naming,
		schema: before ?? extractSchema("", undefined, { dialect, schema }),
		fresh: freshStart(before),
		txmodeNone: dialect === "sqlite" && TXMODE_NONE.test(sql),
		prepared,
		drops: new Map(),
		fired: guards.fired,
		rebuilds,
		reindexed,
		kept: guards.kept,
		renumbered: guards.renumbered,
		unguarded: guards.unguarded,
	}
	return statements.map((stmt, i) => {
		/* comb's own guard around a rebuild, exactly as comb writes it, empties and refills; it loses nothing */
		/* every other statement is rated by the rules, and only as a shape the grammar recognizes */
		const findings = guards.guarded.has(i)
			? []
			: [
					...findingsOf(codes[i] as string, ctx),
					...grammarFindings(codes[i] as string, { ...ctx, ftsTriggers }),
					...(dialect === "sqlite"
						? [...ftsCommandFindings(stmt), ...sqliteWriteFindings(codes[i] as string, ctx)]
						: pgTreeFindings(stmt, ctx, read?.statements[i]?.tree)),
				]
		/* on Postgres what a statement makes new is followed from its parse tree (pg-ddl.ts) */
		if (dialect === "sqlite") {
			followAdds(codes[i] as string, ctx.fresh)
			ctx.schema = extractSchema(stmt, ctx.schema)
		}
		return { code: codes[i] as string, dialect, findings, stmt }
	})
}

/**
 * The file as its dialect reads it; with none named, as SQLite reads it, the CLI's default. On
 * Postgres `read` is the file's one parse, its caller's when it holds one (M86)
 */
const readings = (
	sql: string,
	{ before, dialect, schema }: ClassifyOptions,
	read: PgRead | undefined = dialect === "postgres" ? pgRead(sql) : undefined,
): Read[] => readFile(sql, { before, dialect: dialect ?? "sqlite", schema: schema ?? "public" }, read)

const entries = (reads: readonly Read[], keep: (finding: Finding) => boolean) =>
	reads.flatMap(({ findings, stmt }) =>
		findings.filter(keep).map((f) => (f.note === undefined ? preview(stmt) : `${preview(stmt)} (${f.note})`)),
	)
const at = (level: Finding["level"]) => (finding: Finding) => finding.level === level

/** The table, column and index drops a migration makes, as `DROP TABLE t`, `DROP COLUMN t.c`, `DROP INDEX i` */
function extractDropStatements(sql: string, options: ClassifyOptions = {}): string[] {
	return dropsOf(readings(sql, options))
}

/** The drops the readings of a file find */
const dropsOf = (reads: readonly Read[]): string[] => [
	...new Set(reads.flatMap(({ findings }) => findings.flatMap((f) => f.drops ?? []))),
]

/** How destructive a migration is, which statements make it so, and which block a Postgres table */
function classifyMigration(sql: string, options: ClassifyOptions = {}): MigrationClassification {
	return classificationOf(readings(sql, options), sql)
}

/** classifyMigration of the readings of `sql` */
function classificationOf(reads: readonly Read[], sql: string): MigrationClassification {
	for (const read of reads) refuseUnrunnable(read, sql)
	const unsafeStatements = [...new Set(entries(reads, at("unsafe")))]
	/* a statement is listed once, at the strictest level any reading gives it, whatever each finding's note */
	const unsafe = new Set(
		reads.filter(({ findings }) => findings.some((f) => f.level === "unsafe")).map(({ stmt }) => preview(stmt)),
	)
	const cautiousStatements = [
		...new Set(
			entries(
				reads.filter(({ stmt }) => !unsafe.has(preview(stmt))),
				at("cautious"),
			),
		),
	]
	if (TXMODE_NONE.test(sql)) cautiousStatements.push("-- atlas:txmode none: the file is not applied in one transaction")
	const safety = unsafeStatements.length > 0 ? "unsafe" : cautiousStatements.length > 0 ? "cautious" : "safe"
	return {
		cautiousStatements,
		lockWarnings: [...new Set(entries(reads, at("lock")))],
		pendingStatements: [...new Set(entries(reads, (finding) => finding.pending === true))],
		safety,
		unsafeStatements,
	}
}

export { classificationOf, classifyMigration, type ClassifyOptions, dropsOf, extractDropStatements, readings }
