/**
 * SQL parsing utilities for migrations
 */
import { createHash } from "node:crypto"
import {
	classificationOf,
	classifyMigration,
	type ClassifyOptions,
	dropsOf,
	extractDropStatements,
	readings,
} from "./classify.ts"
import { type FileRead, fileRead } from "./pg-split.ts"
import { extractSchema, schemaOfRead } from "./schema.ts"
import { normalizeSql, splitSqlStatements } from "./sql-scan.ts"
import type { ParsedMigration } from "../types.ts"

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
   SCHEMA EXTRACTION — see schema.ts
   ═══════════════════════════════════════════════════════════════════════════ */

export { extractSchema }

/* ═══════════════════════════════════════════════════════════════════════════
   DROP STATEMENT EXTRACTION AND CLASSIFICATION — see classify.ts
   ═══════════════════════════════════════════════════════════════════════════ */

export { classifyMigration, extractDropStatements }

/* ═══════════════════════════════════════════════════════════════════════════
   PARSE MIGRATION
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A migration file, read as `options.dialect`, classified against `options.before`, the schema the
 * earlier files leave; its statements are applied as written, as wrangler and Atlas apply them
 */
export function parseMigration(sql: string, filename: string, options: ClassifyOptions = {}): ParsedMigration {
	return parseRead({ ...fileRead(sql, options.dialect ?? "sqlite"), filename }, options)
}

/** parseMigration of a file its caller has read: on Postgres its one parse (M86) */
export function parseRead(
	file: FileRead & { filename: string },
	{ before, schema }: Omit<ClassifyOptions, "dialect">,
): ParsedMigration {
	const { dialect, filename, sql } = file
	const reads = readings(sql, { before, dialect, schema }, dialect === "postgres" ? file.read : undefined)
	return {
		classification: classificationOf(reads, sql),
		drops: dropsOf(reads),
		expected: schemaOfRead(file, schema),
		filename,
		hash: generateMigrationHash(sql),
		sql,
		statements: reads.map(({ stmt }) => stmt),
	}
}
