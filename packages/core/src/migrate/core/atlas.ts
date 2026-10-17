/**
 * Atlas CLI integration for schema diffing
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Dialect } from "../types.ts"
import { devUrl } from "./atlas-env.ts"
import { type Run, run } from "./process.ts"

export { applySqliteMigrationTransforms } from "./atlas-env.ts"
export { generateIncrementalMigration, type MigrateDiffOptions, type MigrateDiffResult } from "./migrate-diff.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   ATLAS AVAILABILITY CHECK
   ═══════════════════════════════════════════════════════════════════════════ */

export function checkAtlasInstalled(exec: Run = run): boolean {
	return exec("atlas", ["version"]).code === 0
}

export function getAtlasVersion(exec: Run = run): string | null {
	const result = exec("atlas", ["version"])
	if (result.code !== 0) return null
	return result.stdout.match(/v[\d.]+/)?.[0] ?? null
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA DIFF
   ═══════════════════════════════════════════════════════════════════════════ */

export type SchemaDiffOptions = {
	dialect: Dialect
	fromSchema: string
	toSchema: string
	/** The process runner; tests pass a fake. */
	run?: Run | undefined
}

export type SchemaDiffResult = {
	diff: string | null
	synced: boolean
}

export function generateSchemaDiff(options: SchemaDiffOptions): SchemaDiffResult {
	const { dialect, fromSchema, toSchema, run: exec = run } = options

	const tmpDir = mkdtempSync(join(tmpdir(), "comb-schema-diff-"))

	const fromFile = join(tmpDir, "from.sql")
	const toFile = join(tmpDir, "to.sql")

	try {
		writeFileSync(fromFile, fromSchema)
		writeFileSync(toFile, toSchema)

		const result = exec("atlas", [
			"schema",
			"diff",
			"--from",
			`file://${fromFile}`,
			"--to",
			`file://${toFile}`,
			"--dev-url",
			devUrl(dialect),
		])

		if (result.code !== 0) {
			if (result.stderr.includes("Schemas are synced")) {
				return { diff: null, synced: true }
			}
			throw new Error(`Atlas diff failed: ${result.stderr}`)
		}

		const diff = result.stdout.trim()

		if (!diff || diff === "-- (empty)" || diff.includes("Schemas are synced")) {
			return { diff: null, synced: true }
		}

		return { diff, synced: false }
	} finally {
		rmSync(tmpDir, { force: true, recursive: true })
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   DRIZZLE SCHEMA EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */

export type DrizzleExportOptions = {
	cwd: string
	dialect: Dialect
	/** The process runner; tests pass a fake. */
	run?: Run | undefined
}

export function exportDrizzleSchema(options: DrizzleExportOptions): string {
	const { cwd, dialect, run: exec = run } = options

	const result = exec("bun", ["drizzle-kit", "export"], { cwd })

	if (result.code !== 0) {
		throw new Error(`drizzle-kit export failed: ${result.stderr}`)
	}

	let sql = result.stdout

	/* Normalize for SQLite */
	if (dialect === "sqlite") {
		sql = sql
			.split("\n")
			.filter((line) => !line.trim().startsWith("PRAGMA"))
			.join("\n")
			.replace(/DEFAULT true/g, "DEFAULT 1")
			.replace(/DEFAULT false/g, "DEFAULT 0")
	}

	return sql
}

/* ═══════════════════════════════════════════════════════════════════════════
   GENERATE MIGRATION FILE
   ═══════════════════════════════════════════════════════════════════════════ */

export type GenerateMigrationOptions = {
	migrationsDir: string
	migrationName: string
	diff: string
	description?: string
}

export function generateMigrationFile(options: GenerateMigrationOptions): string {
	const { migrationsDir, migrationName, diff, description } = options

	if (!existsSync(migrationsDir)) {
		mkdirSync(migrationsDir, { recursive: true })
	}

	const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")
	const filename = `${timestamp}_${migrationName}.sql`
	const filepath = join(migrationsDir, filename)

	const header = `-- Migration: ${migrationName}
-- Generated: ${new Date().toISOString()}
${description ? `-- ${description}` : ""}
--
-- Review this migration carefully before applying!

`

	writeFileSync(filepath, header + diff)

	return filepath
}
