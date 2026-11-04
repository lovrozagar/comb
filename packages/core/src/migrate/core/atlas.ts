/**
 * Atlas CLI integration for schema diffing
 */
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Dialect } from "../types.ts"
import { normalizeSqliteExport, sqliteDevUrl } from "./atlas-env.ts"
import { explainAtlasFailure } from "./atlas-failure.ts"
import { atlasNotices, type PgTarget, withAtlasEnv } from "./atlas-target.ts"
import { projectBin } from "./optional-peer.ts"
import { DIFF } from "./peer-needs.ts"
import { type ProjectBin, type Run, run, runPeer } from "./process.ts"
import { codeOf, IDENT, QNAME, unquote } from "./sql-code.ts"
import { readyDevSchema } from "./pg-dev-schema.ts"
import { atlasFile, pgStatements } from "./pg-split.ts"
import { scratchDir } from "./cleanup.ts"

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
	/** Postgres: makes the target's dev schema exist before Atlas diffs in it; tests pass a fake */
	readyDev?: ((target: PgTarget) => Promise<void>) | undefined
}

export type SchemaDiffResult = {
	diff: string | null
	/** what Atlas said on stderr as it succeeded, a line each, for the caller to warn with */
	notices: string[]
	synced: boolean
}

/**
 * Atlas's diff of two schemas, on the dialect's dev database. On Postgres the target's dev schema is
 * made ready first and a failure explained as migrate diff explains one (P8 of r18). devUrl must be
 * a scratch database: with no `target.url`, comb cannot tell it from your real one (P2 of r19).
 */
export async function generateSchemaDiff(options: SchemaDiffOptions): Promise<SchemaDiffResult> {
	const { dialect, fromSchema, toSchema, run: exec = run, target } = options
	if (dialect === "postgres" && target === undefined)
		throw new Error("a Postgres diff needs a target (devUrl and schema)")
	if (dialect === "postgres") await (options.readyDev ?? readyDevSchema)(target as PgTarget)

	const { dir: tmpDir, remove: removeTmpDir } = scratchDir("comb-schema-diff-")

	const fromFile = join(tmpDir, "from.sql")
	const toFile = join(tmpDir, "to.sql")

	try {
		writeFileSync(fromFile, fromSchema)
		writeFileSync(toFile, toSchema)

		const args = ["schema", "diff", "--from", `file://${fromFile}`, "--to", `file://${toFile}`]
		const result =
			target === undefined || dialect === "sqlite"
				? exec("atlas", [...args, "--dev-url", sqliteDevUrl()])
				: withAtlasEnv(target, { dev: true }, (env) => {
						const ran = exec("atlas", [...args, ...env.args], { env: env.env })
						return { ...ran, stderr: explainAtlasFailure(ran.stderr, env.scrub, { devOnly: true }) }
					})

		if (result.code !== 0) throw new Error(`Atlas diff failed: ${result.stderr.trim()}`)
		/* in sync, Atlas exits 0 and says so on stdout (probed on v1.3.0) */
		const diff = result.stdout.trim()
		const notices = atlasNotices(result.stderr)
		return diff.includes("Schemas are synced")
			? { diff: null, notices, synced: true }
			: { diff, notices, synced: false }
	} finally {
		removeTmpDir()
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
	const statements = pgStatements(sql)
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
	return kept.length === statements.length ? sql : atlasFile(kept)
}

/**
 * drizzle-kit's export of the schema, normalized for the dialect: on Postgres, scoped to the
 * database's schema and read as the statements Postgres runs, so `loadPostgresParser()` first
 */
export function exportDrizzleSchema(options: DrizzleExportOptions): string {
	return exportWith(projectBin(DIFF, options.cwd), options)
}

/** The config drizzle-kit loads: the one given, else the first of its own defaults cwd holds (D3-2 of the area D round-three review) */
function drizzleConfigOf(configPath: string | undefined, cwd: string): string | undefined {
	if (configPath !== undefined) return configPath
	const found = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.json"].find((name) =>
		existsSync(join(cwd, name)),
	)
	return found === undefined ? undefined : join(cwd, found)
}

/** exportDrizzleSchema through `drizzleKit`, the bin the command checked: its runtime on the project's bin (K1 of r22) */
export function exportWith(drizzleKit: ProjectBin, options: DrizzleExportOptions): string {
	const { configPath, cwd, dialect, run: exec = run } = options

	/* drizzle-kit runs on comb's runtime, and on Node it cannot load a JSON config (D2-14 of the area D round-two review) */
	const loads = drizzleConfigOf(configPath, cwd)
	if (loads?.endsWith(".json") === true && process.versions["bun"] === undefined)
		throw new Error(
			`${loads} is JSON, which drizzle-kit cannot load when comb runs on Node: write it as drizzle.config.ts, export default the same object, or run comb on Bun`,
		)
	const config = configPath === undefined ? [] : ["--config", configPath]
	const result = runPeer(exec, drizzleKit)(["export", ...config], { cwd })

	if (result.code !== 0) {
		throw new Error(`drizzle-kit export failed: ${result.stderr.trim()}`)
	}

	let sql = result.stdout

	/* Normalize for SQLite: no pragmas, integer booleans, and a primary key that cannot hold NULL */
	if (dialect === "sqlite") {
		sql = normalizeSqliteExport(
			sql
				.split("\n")
				.filter((line) => !line.trim().startsWith("PRAGMA"))
				.join("\n")
				.replace(/DEFAULT true/g, "DEFAULT 1")
				.replace(/DEFAULT false/g, "DEFAULT 0"),
		)
	}

	return dialect === "postgres" ? scopeExport(sql, options.schema ?? "public") : sql
}
