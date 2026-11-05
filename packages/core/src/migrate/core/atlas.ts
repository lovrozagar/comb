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
import { codeOf } from "../../sql-lexer.ts"
import { IDENT, QNAME, unquote } from "./sql-code.ts"
import { readyDevSchema } from "./pg-dev-schema.ts"
import { atlasFile, pgStatements } from "./pg-split.ts"
import { scratchDir } from "./cleanup.ts"

export { applySqliteMigrationTransforms } from "./atlas-env.ts"
export { generateIncrementalMigration, type MigrateDiffOptions, type MigrateDiffResult } from "./migrate-diff.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   ATLAS AVAILABILITY CHECK
   ═══════════════════════════════════════════════════════════════════════════ */

/** Whether `atlas version` runs and exits 0: the Atlas CLI is on PATH */
export async function checkAtlasInstalled(exec: Run = run): Promise<boolean> {
	return (await exec("atlas", ["version"])).code === 0
}

/** The version `atlas version` prints, as `v1.3.0`; null when Atlas does not run or prints none */
export async function getAtlasVersion(exec: Run = run): Promise<string | null> {
	const result = await exec("atlas", ["version"])
	if (result.code !== 0) return null
	return result.stdout.match(/v[\d.]+/)?.[0] ?? null
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCHEMA DIFF
   ═══════════════════════════════════════════════════════════════════════════ */

/** What `generateSchemaDiff` diffs, and where */
export type SchemaDiffOptions = {
	/** the dialect both schemas are written in */
	dialect: Dialect
	/** the SQL DDL of the schema the diff starts from */
	fromSchema: string
	/** the SQL DDL of the schema the diff ends at */
	toSchema: string
	/** The process runner; tests pass a fake. */
	run?: Run | undefined
	/** Postgres: the dev database and schema Atlas diffs in */
	target?: PgTarget | undefined
	/** Postgres: makes the target's dev schema exist before Atlas diffs in it; tests pass a fake */
	readyDev?: ((target: PgTarget) => Promise<void>) | undefined
}

/** What Atlas's diff of two schemas found */
export type SchemaDiffResult = {
	/** the statements that take `fromSchema` to `toSchema`; null when the two are in sync */
	diff: string | null
	/** what Atlas said on stderr as it succeeded, a line each, for the caller to warn with */
	notices: string[]
	/** the two schemas are the same, so there is nothing to apply */
	synced: boolean
}

// P8 of r18, P2 of r19
/**
 * Atlas's diff of two schemas, on the dialect's dev database: an in-memory one for SQLite, and on
 * Postgres `target.devUrl`, whose schema is made to exist first. Throws when a Postgres diff has no
 * `target`, or when Atlas fails, with what it said. `devUrl` must be a scratch database: with no
 * `target.url`, comb cannot tell it from your real one
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
				? await exec("atlas", [...args, "--dev-url", sqliteDevUrl()])
				: await withAtlasEnv(target, { dev: true }, async (env) => {
						const ran = await exec("atlas", [...args, ...env.args], { env: env.env })
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

/** What `exportDrizzleSchema` exports, and from where */
export type DrizzleExportOptions = {
	/** The drizzle config to export, when it is not drizzle-kit's default in cwd */
	configPath?: string | undefined
	/** the folder drizzle-kit runs in, which a relative `configPath` resolves against */
	cwd: string
	/** the drizzle config's dialect, which the export is normalized for: SQLite's without PRAGMA lines and with 0/1 boolean defaults, Postgres's scoped to `schema` */
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
export async function exportDrizzleSchema(options: DrizzleExportOptions): Promise<string> {
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
export async function exportWith(drizzleKit: ProjectBin, options: DrizzleExportOptions): Promise<string> {
	const { configPath, cwd, dialect, run: exec = run } = options

	/* drizzle-kit runs on comb's runtime, and on Node it cannot load a JSON config (D2-14 of the area D round-two review) */
	const loads = drizzleConfigOf(configPath, cwd)
	if (loads?.endsWith(".json") === true && process.versions["bun"] === undefined)
		throw new Error(
			`${loads} is JSON, which drizzle-kit cannot load when comb runs on Node: write it as drizzle.config.ts, export default the same object, or run comb on Bun`,
		)
	const config = configPath === undefined ? [] : ["--config", configPath]
	const result = await runPeer(exec, drizzleKit)(["export", ...config], { cwd })

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
