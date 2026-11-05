/**
 * SQL parsing utilities for migrations
 */
import { createHash } from "node:crypto"
import { strayDirective } from "./atlas-header.ts"
import { classifyMigration, type ClassifyOptions, dropsOf, extractDropStatements, readings } from "./classify.ts"
import { takenOptions } from "./classify-options.ts"
import { classificationOf } from "./classify-verdict.ts"
import { type FileRead, fileRead } from "./pg-split.ts"
import { extractSchema, schemaOfRead } from "./schema.ts"
import { hashedSql, splitSqlStatements } from "./sql-scan.ts"
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
	return createHash("sha256").update(hashedSql(sql)).digest("hex")
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

/**
 * The hash comb 0.5.0 to 0.20 recorded, whose normalizing folded every Unicode space, which SQLite
 * reads as part of a name: an edit from `a b` to `a\u00a0b` kept it (SL5 of r22)
 */
export function foldedMigrationHash(sql: string): string {
	return createHash("sha256").update(hashedSql(sql, true)).digest("hex")
}

/** When v0.5.0, which changed the hash, was tagged (2026-10-18T00:56:29Z, ms): a row recorded before it may hold the legacy hash */
export const V0_5_0: number = 1792284989000

/**
 * When comb's hash began to keep the spaces SQLite reads as part of a name (2026-11-03T19:00:00Z, ms,
 * SL5 of r22): a row recorded before it may hold the folded hash. A row since then holds the current
 * one, so a match by the folded hash is an edit that folding hides.
 */
export const SPACES_KEPT_SINCE: number = 1793732400000

/** A hash a file's text may be recorded under, on a row recorded before `until` */
export type AcceptedHash = { hash: string; until: number }

/**
 * Every hash `sql` may be recorded under, current first, each with the time before which a row may
 * hold it: the current one on any row, the folded one (0.5.0 to 0.20) before SPACES_KEPT_SINCE, the
 * pre-0.5.0 one before V0_5_0
 */
export function migrationHashes(sql: string): AcceptedHash[] {
	const accepted: AcceptedHash[] = []
	for (const [hash, until] of [
		[generateMigrationHash(sql), Infinity],
		[foldedMigrationHash(sql), SPACES_KEPT_SINCE],
		[legacyMigrationHash(sql), V0_5_0],
	] as const)
		if (!accepted.some((each) => each.hash === hash)) accepted.push({ hash, until })
	return accepted
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
	const taken = takenOptions("parseMigration", options)
	return parseRead({ ...fileRead(sql, taken.dialect ?? "sqlite"), filename }, taken)
}

/** Refuses `sql`, the file `filename`, when Atlas reads a leading `atlas:` line of it as a comment (PA3n of r22b) */
function refuseStrayDirective(sql: string, filename: string): void {
	const stray = strayDirective(sql)
	if (stray === undefined) return
	throw new Error(
		`${filename} line ${stray.line}: Atlas reads ${JSON.stringify(stray.text)} as a comment, since no blank line closes the comments the file opens with, and runs the file in a transaction; add a blank line after the line, or remove it`,
	)
}

/** parseMigration of a file its caller has read: on Postgres its one parse (M86) */
export function parseRead(
	file: FileRead & { filename: string },
	{ before, kind, schema }: Omit<ClassifyOptions, "dialect">,
): ParsedMigration {
	const { dialect, filename, sql } = file
	refuseStrayDirective(sql, filename)
	const reads = readings(sql, { before, dialect, schema }, dialect === "postgres" ? file.read : undefined)
	return {
		classification: classificationOf(reads, sql, { kind }),
		drops: dropsOf(reads),
		expected: schemaOfRead(file, schema),
		filename,
		hash: generateMigrationHash(sql),
		sql,
		statements: reads.map(({ stmt }) => stmt),
	}
}
