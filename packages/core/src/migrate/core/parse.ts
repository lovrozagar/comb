/**
 * SQL parsing utilities for migrations
 */
import { createHash } from "node:crypto"
import { normalizeSql, segments, splitSqlStatements } from "./sql-scan.ts"
import type { ExtractedSchema, MigrationClassification, MigrationSafety, ParsedMigration } from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   SQL STATEMENT SPLITTING — see sql-scan.ts
   ═══════════════════════════════════════════════════════════════════════════ */

export { splitSqlStatements }

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION HASH
   ═══════════════════════════════════════════════════════════════════════════ */

/** The hash a migration is recorded under: its SQL with comments and layout normalized away */
export function generateMigrationHash(sql: string): string {
	return createHash("sha256").update(normalizeSql(sql)).digest("hex")
}

/**
 * The hash comb before 0.5.0 recorded. Its regexes stripped `--` and `/* *\/` inside string
 * literals and kept a final comment with no newline, so the same file can hash differently now;
 * a migration recorded under this hash is still applied.
 */
export function legacyMigrationHash(sql: string): string {
	const normalized = sql
		.replace(/--[^\n]*\n/g, "\n")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.trim()
	return createHash("sha256").update(normalized).digest("hex")
}

/** Every hash `sql` may be recorded under, current first */
export function migrationHashes(sql: string): string[] {
	const current = generateMigrationHash(sql)
	const legacy = legacyMigrationHash(sql)
	return legacy === current ? [current] : [current, legacy]
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA EXTRACTION
   ═══════════════════════════════════════════════════════════════════════════ */

const CONSTRAINT_WORDS = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)/i

/** The column definitions of a CREATE TABLE body: its top-level comma-separated parts */
function bodyParts(stmt: string): string[] {
	const open = stmt.indexOf("(")
	const parts: string[] = []
	let depth = 0
	let start = open + 1
	for (let i = open + 1; i < stmt.length; i++) {
		const char = stmt[i]
		if (char === "(") depth++
		else if (char === ")" && depth === 0) return [...parts, stmt.slice(start, i).trim()]
		else if (char === ")") depth--
		else if (char === "," && depth === 0) {
			parts.push(stmt.slice(start, i).trim())
			start = i + 1
		}
	}
	return [...parts, stmt.slice(start).trim()]
}

/** The column names a CREATE TABLE declares, table constraints left out */
function columnNames(stmt: string): string[] {
	return bodyParts(stmt)
		.map((def) => /^["'`]?(\w+)["'`]?\s+/.exec(def)?.[1])
		.filter((name): name is string => name !== undefined && !CONSTRAINT_WORDS.test(name))
}

type SchemaSoFar = { droppedTables: string[]; indexes: string[]; tables: Map<string, string[]> }

const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?\s*\(/i
const CREATE_INDEX = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i
const DROP_TABLE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i
/* Atlas's table rebuild: create `new_t`, copy rows, drop `t`, rename `new_t` to `t` */
const RENAME_TABLE = /ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+TO\s+["'`]?(\w+)["'`]?/i

/** What one statement does to the schema being followed */
function follow(schema: SchemaSoFar, stmt: string): void {
	const created = CREATE_TABLE.exec(stmt)?.[1]
	if (created !== undefined) schema.tables.set(created, columnNames(stmt))
	const index = CREATE_INDEX.exec(stmt)?.[1]
	if (index !== undefined) schema.indexes.push(index)
	const dropped = DROP_TABLE.exec(stmt)?.[1]
	if (dropped !== undefined) {
		schema.droppedTables.push(dropped)
		schema.tables.delete(dropped)
	}
	const [, from, to] = RENAME_TABLE.exec(stmt) ?? []
	const columns = from === undefined ? undefined : schema.tables.get(from)
	if (columns !== undefined && to !== undefined) {
		schema.tables.delete(from as string)
		schema.tables.set(to, columns)
	}
}

/** The tables (with columns), indexes and dropped tables a migration leaves */
export function extractSchema(sql: string): ExtractedSchema {
	const schema: SchemaSoFar = { droppedTables: [], indexes: [], tables: new Map() }
	for (const stmt of splitSqlStatements(sql)) follow(schema, stmt)
	return schema
}

/* ═══════════════════════════════════════════════════════════════════════════
   DROP STATEMENT EXTRACTION AND CLASSIFICATION — on code, never on literal text
   ═══════════════════════════════════════════════════════════════════════════ */

/** A statement's code with its identifiers, strings and comments blanked out, whitespace collapsed */
const codeOf = (stmt: string) =>
	segments(stmt)
		.map((segment) => (segment.kind === "code" || segment.kind === "identifier" ? segment.text : " "))
		.join("")
		.replace(/\s+/g, " ")
		.trim()

const DROPS_TABLE = /^DROP TABLE (?:IF EXISTS )?["'`]?(\w+)/i
const DROPS_COLUMN = /^ALTER TABLE ["'`]?(\w+)["'`]? DROP (?:COLUMN )?["'`]?(\w+)/i
const DROPS_INDEX = /^DROP INDEX (?:IF EXISTS )?["'`]?(\w+)/i

/** The table, column and index drops a migration makes, as `DROP TABLE t`, `DROP COLUMN t.c`, `DROP INDEX i` */
export function extractDropStatements(sql: string): string[] {
	const drops: string[] = []
	for (const stmt of splitSqlStatements(sql)) {
		const code = codeOf(stmt)
		const table = DROPS_TABLE.exec(code)?.[1]
		const [, from, column] = DROPS_COLUMN.exec(code) ?? []
		const index = DROPS_INDEX.exec(code)?.[1]
		if (table !== undefined) drops.push(`DROP TABLE ${table}`)
		if (from !== undefined && column !== undefined) drops.push(`DROP COLUMN ${from}.${column}`)
		if (index !== undefined) drops.push(`DROP INDEX ${index}`)
	}
	return drops
}

/** Whether a statement's code loses data or fails on a populated table */
function isUnsafe(code: string): boolean {
	if (DROPS_TABLE.test(code) || DROPS_COLUMN.test(code) || /^TRUNCATE\b/i.test(code)) return true
	/* a NOT NULL column with no default cannot be added to a table that has rows */
	return /^ALTER TABLE\b/i.test(code) && /\bNOT NULL\b/i.test(code) && !/\bDEFAULT\b/i.test(code)
}

const preview = (stmt: string) => stmt.slice(0, 80) + (stmt.length > 80 ? "..." : "")

/**
 * unsafe: a statement drops a table or column, truncates, or adds a NOT NULL column without a
 * default; cautious: it drops something else (an index, a trigger, a view); safe otherwise.
 */
export function classifyMigration(sql: string): MigrationClassification {
	const statements = splitSqlStatements(sql)
	const unsafeStatements = statements.filter((stmt) => isUnsafe(codeOf(stmt))).map(preview)
	const drops = statements.some((stmt) => /^DROP\b/i.test(codeOf(stmt)))
	const safety: MigrationSafety = unsafeStatements.length > 0 ? "unsafe" : drops ? "cautious" : "safe"
	return { safety, unsafeStatements }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAKE IDEMPOTENT
   ═══════════════════════════════════════════════════════════════════════════ */

export function makeIdempotent(statements: string[]): string[] {
	return statements.map((stmt) => {
		const trimmed = stmt.trim()

		/* CREATE INDEX → CREATE INDEX IF NOT EXISTS */
		if (/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i.test(trimmed)) {
			return trimmed.replace(/^(CREATE\s+)(UNIQUE\s+)?(INDEX\s+)/i, "$1$2$3IF NOT EXISTS ")
		}

		/* DROP INDEX → DROP INDEX IF EXISTS */
		if (/^DROP\s+INDEX\s+(?!IF\s+EXISTS)/i.test(trimmed)) {
			return trimmed.replace(/^(DROP\s+INDEX\s+)/i, "$1IF EXISTS ")
		}

		return stmt
	})
}

/* ═══════════════════════════════════════════════════════════════════════════
   PARSE MIGRATION
   ═══════════════════════════════════════════════════════════════════════════ */

export function parseMigration(sql: string, filename: string): ParsedMigration {
	const hash = generateMigrationHash(sql)
	const expected = extractSchema(sql)
	const statements = makeIdempotent(splitSqlStatements(sql))
	const drops = extractDropStatements(sql)
	const classification = classifyMigration(sql)

	return {
		classification,
		drops,
		expected,
		filename,
		hash,
		sql,
		statements,
	}
}
