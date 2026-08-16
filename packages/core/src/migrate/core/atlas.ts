/**
 * Atlas CLI integration for schema diffing
 */
import { execSync, spawnSync } from "child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import type { Dialect } from "../types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   SQLITE MIGRATION POST-PROCESSOR

   Atlas emits SQLite table-rewrite diffs wrapped in
   `PRAGMA foreign_keys = off;` / `PRAGMA foreign_keys = on;`. That pattern
   fails on fresh DBs when a CREATE references a table created LATER in the
   same diff. Swap for `PRAGMA defer_foreign_keys = on;` (standard SQLite,
   libsql, D1) — FK enforcement deferred to commit; every table exists by then.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Idempotent. Input without the pragma pair passes through unchanged. */
export function applySqliteMigrationTransforms(sql: string): string {
	/* Opening: optional "-- Disable ..." comment + PRAGMA foreign_keys = off; */
	let out = sql.replace(
		/(?:^|\n)(?:[ \t]*-- Disable the enforcement of foreign-keys constraints[ \t]*\n)?[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=[ \t]*off[ \t]*;[ \t]*\n?/i,
		(match) => `${match.startsWith("\n") ? "\n" : ""}PRAGMA defer_foreign_keys = on;\n`,
	)

	/* Closing: optional "-- Enable back ..." comment + PRAGMA foreign_keys = on; */
	out = out.replace(
		/(?:[ \t]*-- Enable back the enforcement of foreign-keys constraints[ \t]*\n)?[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=[ \t]*on[ \t]*;[ \t]*\n?/i,
		"",
	)

	return out
}

/* ═══════════════════════════════════════════════════════════════════════════
   ATLAS AVAILABILITY CHECK
   ═══════════════════════════════════════════════════════════════════════════ */

export function checkAtlasInstalled(): boolean {
	try {
		execSync("atlas version", { encoding: "utf-8", stdio: "pipe" })
		return true
	} catch {
		return false
	}
}

export function getAtlasVersion(): string | null {
	try {
		const output = execSync("atlas version", { encoding: "utf-8", stdio: "pipe" })
		const match = output.match(/v[\d.]+/)
		return match?.[0] ?? null
	} catch {
		return null
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   DEV URL FOR DIALECT
   ═══════════════════════════════════════════════════════════════════════════ */

function getDevUrl(dialect: Dialect): string {
	switch (dialect) {
		case "sqlite":
			return "sqlite://file?mode=memory"
		case "postgres":
			return "postgres://localhost:5432/dev?sslmode=disable"
		default:
			throw new Error(`Unsupported dialect: ${dialect}`)
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA DIFF
   ═══════════════════════════════════════════════════════════════════════════ */

export type SchemaDiffOptions = {
	dialect: Dialect
	fromSchema: string
	toSchema: string
}

export type SchemaDiffResult = {
	diff: string | null
	synced: boolean
}

export function generateSchemaDiff(options: SchemaDiffOptions): SchemaDiffResult {
	const { dialect, fromSchema, toSchema } = options

	const tmpDir = `/tmp/db-migration-diff-${Date.now()}`
	mkdirSync(tmpDir, { recursive: true })

	const fromFile = join(tmpDir, "from.sql")
	const toFile = join(tmpDir, "to.sql")

	try {
		writeFileSync(fromFile, fromSchema)
		writeFileSync(toFile, toSchema)

		const result = spawnSync(
			"atlas",
			["schema", "diff", "--from", `file://${fromFile}`, "--to", `file://${toFile}`, "--dev-url", getDevUrl(dialect)],
			{ encoding: "utf-8" },
		)

		if (result.status !== 0) {
			if (result.stderr?.includes("Schemas are synced")) {
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
		/* Cleanup temp files */
		try {
			unlinkSync(fromFile)
			unlinkSync(toFile)
		} catch {}
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   INCREMENTAL MIGRATE DIFF

   Uses `atlas migrate diff` which replays the existing migrations directory to
   an ephemeral dev database, then diffs the result against the target schema
   and emits only the delta. This is the correct way to produce incremental
   migrations — the `atlas schema diff` path (generateSchemaDiff above) is only
   useful when you have no migration history to replay from.
   ═══════════════════════════════════════════════════════════════════════════ */

export type MigrateDiffOptions = {
	dialect: Dialect
	migrationName: string
	migrationsDir: string
	targetSchema: string
}

export type MigrateDiffResult = {
	files: string[]
	synced: boolean
}

export function generateIncrementalMigration(options: MigrateDiffOptions): MigrateDiffResult {
	const { dialect, migrationName, migrationsDir, targetSchema } = options

	if (!existsSync(migrationsDir)) {
		mkdirSync(migrationsDir, { recursive: true })
	}

	const sumFile = join(migrationsDir, "atlas.sum")
	if (!existsSync(sumFile)) {
		/* Bootstrap atlas.sum so `atlas migrate diff` can replay history. */
		const hashResult = spawnSync("atlas", ["migrate", "hash", "--dir", `file://${migrationsDir}`], {
			encoding: "utf-8",
		})
		if (hashResult.status !== 0) {
			throw new Error(`atlas migrate hash failed: ${hashResult.stderr}`)
		}
	}

	const tmpDir = `/tmp/db-migrate-diff-${Date.now()}`
	mkdirSync(tmpDir, { recursive: true })
	const toFile = join(tmpDir, "schema.sql")

	try {
		writeFileSync(toFile, targetSchema)

		const beforeFiles = new Set(readdirSync(migrationsDir))
		const result = spawnSync(
			"atlas",
			[
				"migrate",
				"diff",
				migrationName,
				"--dir",
				`file://${migrationsDir}`,
				"--to",
				`file://${toFile}`,
				"--dev-url",
				getDevUrl(dialect),
				"--format",
				"{{ sql . }}",
			],
			{ encoding: "utf-8" },
		)

		const stderr = result.stderr ?? ""
		const stdout = (result.stdout ?? "").trim()

		/* Atlas reports "synced" / "no changes" via stderr and exits 0 — not
		   via a nonzero exit code. Detect both. */
		if (stderr.includes("no changes to be made") || stderr.includes("synced")) {
			return { files: [], synced: true }
		}

		if (result.status !== 0) {
			throw new Error(`atlas migrate diff failed: ${stderr || stdout}`)
		}

		const afterFiles = readdirSync(migrationsDir)
		const newFiles = afterFiles
			.filter((f: string) => !beforeFiles.has(f) && f !== "atlas.sum")
			.map((f: string) => join(migrationsDir, f))

		if (newFiles.length === 0) {
			return { files: [], synced: true }
		}

		/* Apply SQLite post-processors to newly generated files. */
		if (dialect === "sqlite") {
			for (const f of newFiles) {
				const content = readFileSync(f, "utf-8")
				const transformed = applySqliteMigrationTransforms(content)
				if (transformed !== content) {
					writeFileSync(f, transformed)
				}
			}
		}

		return { files: newFiles, synced: false }
	} finally {
		try {
			unlinkSync(toFile)
		} catch {}
	}
}

/* ═══════════════════════════════════════════════════════════════════════════
   DRIZZLE SCHEMA EXPORT
   ═══════════════════════════════════════════════════════════════════════════ */

export type DrizzleExportOptions = {
	cwd: string
	dialect: Dialect
}

export function exportDrizzleSchema(options: DrizzleExportOptions): string {
	const { cwd, dialect } = options

	const result = spawnSync("bun", ["drizzle-kit", "export"], {
		cwd,
		encoding: "utf-8",
	})

	if (result.status !== 0) {
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
