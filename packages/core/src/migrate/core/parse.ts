/**
 * SQL parsing utilities for migrations
 */
import { createHash } from "node:crypto"
import { classifyMigration, type ClassifyOptions, extractDropStatements } from "./classify.ts"
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"
import type { ExtractedSchema, ParsedMigration } from "../types.ts"

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

const ADDS_OR_DROPS = /^\s*ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+(ADD|DROP)\s+(?:COLUMN\s+)?["'`]?(\w+)/i
const RENAMES_COLUMN =
	/^\s*ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+(?:COLUMN\s+)?["'`]?(\w+)["'`]?\s+TO\s+["'`]?(\w+)/i

/** What an ALTER TABLE ADD, DROP or RENAME COLUMN does to a followed table's columns */
function followColumns(schema: SchemaSoFar, stmt: string): void {
	const [, table, verb, column] = ADDS_OR_DROPS.exec(stmt) ?? []
	const columns = table === undefined ? undefined : schema.tables.get(table)
	if (columns !== undefined && !/^(?:CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)$/i.test(column as string)) {
		const kept = columns.filter((name) => name !== column)
		schema.tables.set(table as string, verb?.toUpperCase() === "ADD" ? [...kept, column as string] : kept)
	}
	const [, renamedIn, from, to] = RENAMES_COLUMN.exec(stmt) ?? []
	const before = renamedIn === undefined ? undefined : schema.tables.get(renamedIn)
	if (before !== undefined)
		schema.tables.set(
			renamedIn as string,
			before.map((name) => (name === from ? (to as string) : name)),
		)
}

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
	followColumns(schema, stmt)
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
   DROP STATEMENT EXTRACTION AND CLASSIFICATION — see classify.ts
   ═══════════════════════════════════════════════════════════════════════════ */

export { classifyMigration, extractDropStatements }

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

/** A migration file, classified against `options.before`, the schema the earlier files leave */
export function parseMigration(sql: string, filename: string, options: ClassifyOptions = {}): ParsedMigration {
	const hash = generateMigrationHash(sql)
	const expected = extractSchema(sql)
	const statements = makeIdempotent(splitSqlStatements(sql))
	const drops = extractDropStatements(sql, options)
	const classification = classifyMigration(sql, options)

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
