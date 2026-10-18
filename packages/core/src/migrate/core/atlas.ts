/**
 * Atlas CLI integration for schema diffing
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Dialect } from "../types.ts"
import { SQLITE_DEV_URL } from "./atlas-env.ts"
import { type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { type Run, run } from "./process.ts"
import { codeOf, IDENT, QNAME, unquote } from "./sql-code.ts"
import { splitSqlStatements } from "./sql-scan.ts"

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
	/** Postgres: the dev database and schema Atlas diffs in */
	target?: PgTarget | undefined
}

export type SchemaDiffResult = {
	diff: string | null
	synced: boolean
}

export function generateSchemaDiff(options: SchemaDiffOptions): SchemaDiffResult {
	const { dialect, fromSchema, toSchema, run: exec = run, target } = options
	if (dialect === "postgres" && target === undefined)
		throw new Error("a Postgres diff needs a target (devUrl and schema)")

	const tmpDir = mkdtempSync(join(tmpdir(), "comb-schema-diff-"))

	const fromFile = join(tmpDir, "from.sql")
	const toFile = join(tmpDir, "to.sql")

	try {
		writeFileSync(fromFile, fromSchema)
		writeFileSync(toFile, toSchema)

		const args = ["schema", "diff", "--from", `file://${fromFile}`, "--to", `file://${toFile}`]
		const result =
			target === undefined || dialect === "sqlite"
				? exec("atlas", [...args, "--dev-url", SQLITE_DEV_URL])
				: withAtlasEnv(target, { dev: true }, (env) => {
						const ran = exec("atlas", [...args, ...env.args], { env: env.env })
						return { ...ran, stderr: env.scrub(ran.stderr) }
					})

		if (result.code !== 0) throw new Error(`Atlas diff failed: ${result.stderr}`)
		/* in sync, Atlas exits 0 and says so on stdout (probed on v1.3.0) */
		const diff = result.stdout.trim()
		return diff.includes("Schemas are synced") ? { diff: null, synced: true } : { diff, synced: false }
	} finally {
		rmSync(tmpDir, { force: true, recursive: true })
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   DRIZZLE SCHEMA EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */

export type DrizzleExportOptions = {
	/** The drizzle config to export, when it is not drizzle-kit's default in cwd */
	configPath?: string | undefined
	cwd: string
	dialect: Dialect
	/** The process runner; tests pass a fake. */
	run?: Run | undefined
	/** Postgres: the one schema the database's migrations own; default `public` */
	schema?: string | undefined
}

// per-process-constant: the positions in a statement that name an object, composed once
const OBJECT_NAMES = /* @__PURE__ */ new RegExp(
	`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${IDENT} )?ON (?:ONLY )?(${QNAME})|^CREATE (?:TABLE|SEQUENCE|VIEW|MATERIALIZED VIEW|TYPE) (?:IF NOT EXISTS )?(${QNAME})|^CREATE POLICY ${IDENT} ON (${QNAME})|^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${QNAME})`,
	"i",
)
// per-process-constant: a foreign key's target, composed once
const REFERENCES = /* @__PURE__ */ new RegExp(`\\bREFERENCES (${QNAME})`, "gi")
const CREATE_SCHEMA = /^CREATE SCHEMA (?:IF NOT EXISTS )?(\S+)$/i

/** The schemas a statement's object names are qualified with */
function schemasNamed(code: string): string[] {
	const names = [...(OBJECT_NAMES.exec(code)?.slice(1) ?? []), ...[...code.matchAll(REFERENCES)].map((m) => m[1])]
	return names.flatMap((name) => {
		const parts = name === undefined ? [] : unquote(name).split(".")
		return parts.length === 2 ? [parts[0] as string] : []
	})
}

/**
 * drizzle's Postgres export as Atlas may see it in a run scoped to `schema`: that schema's own
 * CREATE SCHEMA dropped (the scoped run has it), and any object in another schema refused
 */
function scopeExport(sql: string, schema: string): string {
	const kept: string[] = []
	const statements = splitSqlStatements(sql, "postgres")
	for (const statement of statements) {
		const code = codeOf(statement, "postgres")
		const created = CREATE_SCHEMA.exec(code)?.[1]
		const outside =
			created === undefined ? schemasNamed(code).some((name) => name !== schema) : unquote(created) !== schema
		if (outside) {
			throw new Error(
				`the drizzle schema creates objects outside schema "${schema}" (${statement.trim()}); comb migrates one schema per database`,
			)
		}
		if (created === undefined) kept.push(statement)
	}
	return kept.length === statements.length ? sql : `${kept.join(";\n")};\n`
}

export function exportDrizzleSchema(options: DrizzleExportOptions): string {
	const { configPath, cwd, dialect, run: exec = run } = options

	const config = configPath === undefined ? [] : ["--config", configPath]
	const result = exec("bun", ["drizzle-kit", "export", ...config], { cwd })

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

	return dialect === "postgres" ? scopeExport(sql, options.schema ?? "public") : sql
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
