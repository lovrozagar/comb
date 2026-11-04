/** `comb migrate`: init, diff, check, apply, baseline and status. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs, refuseFurther } from "./args.ts"
import { binOf } from "../migrate/core/optional-peer.ts"
import { declaredFts, ftsSql } from "./comb-config.ts"
import {
	checkDialect,
	DIALECT_NAMES,
	type Dialect,
	type Expected,
	literalDialect,
	statedDialect,
} from "./drizzle-dialect.ts"
import { migrateApply, needPeers } from "./migrate-apply.ts"
import { type MigrateTarget, refuseBlank, refuseNoDir, resolveMigrateTarget } from "./migrate-target.ts"
import { CliError, type CliContext } from "./output.ts"

const DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit"

export default defineConfig({
	dialect: "sqlite",
	out: "./atlas-migrations",
	schema: "./src/**/*.tables.ts",
})
`

const PG_DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit"

/* drizzle-kit export reads no database, so this config holds no credentials */
export default defineConfig({
	dialect: "postgresql",
	out: "./atlas-migrations",
	schema: "./src/**/*.tables.ts",
})
`

const PG_MIGRATE_CONFIG = `import { defineConfig } from "@lovrozagar/comb/migrate"

export default defineConfig({
	databases: {
		core: {
			drizzleConfigPath: "./drizzle.config.ts",
			migrationsDir: "./atlas-migrations",
			name: "core",
			provider: {
				type: "postgres",
				/* a direct, non-pooled URL with sslmode=verify-full, from the environment, never written here */
				url: process.env["DATABASE_URL"] ?? "",
			},
		},
	},
})
`

/**
 * The starter files of each dialect, in the order they are written. No atlas.hcl: comb runs Atlas
 * with a config of its own, so a project's would hold a guard no comb command reads (C11)
 */
function starterFiles(dialect: Dialect): ReadonlyArray<readonly [string, string]> {
	if (dialect === "sqlite") return [["drizzle.config.ts", DRIZZLE_CONFIG]]
	return [
		["drizzle.config.ts", PG_DRIZZLE_CONFIG],
		["comb.migrate.config.ts", PG_MIGRATE_CONFIG],
	]
}

/**
 * Write each starter file of the dialect --dialect names that does not exist yet, refused when the
 * drizzle config already there states the other dialect (KC1 of r22b)
 */
function migrateInit(argv: readonly string[], io: CliContext): void {
	const option = parseArgs(argv, "migrate init").options["dialect"] ?? "sqlite"
	if (option !== "sqlite" && option !== "postgres")
		throw new CliError(`Unknown --dialect "${String(option)}": use sqlite or postgres`)
	const dialect: Dialect = option
	const config = path.join(io.cwd, "drizzle.config.ts")
	const stated = fs.existsSync(config) ? literalDialect(fs.readFileSync(config, "utf8")) : undefined
	if (stated !== undefined) {
		const but = `migrate init --dialect ${dialect} writes a ${DIALECT_NAMES[dialect]} project`
		checkDialect(config, stated, { but, dialect, otherwise: ", or remove it and run init again" })
	}
	for (const [name, content] of starterFiles(dialect)) {
		const file = path.join(io.cwd, name)
		if (fs.existsSync(file)) continue
		fs.writeFileSync(file, content)
		io.out(`Created: ${name}`)
	}
	const migrationsDir = path.join(io.cwd, "atlas-migrations")
	if (!fs.existsSync(migrationsDir)) {
		fs.mkdirSync(migrationsDir, { recursive: true })
		io.out("Created: atlas-migrations/")
	}
}

/**
 * The next migration for `db`: Atlas's diff of the exported schema, plus what comb writes itself
 * (FTS5 on SQLite, the objects Atlas OSS refuses on Postgres). With comb.migrate.config.ts the
 * database's dialect, directory and drizzle config come from it; without, it is SQLite in
 * ./atlas-migrations.
 */
async function migrateDiff(argv: readonly string[], io: CliContext): Promise<void> {
	const args = parseArgs(argv, "migrate diff")
	/* parseArgs refuses a diff that names no database (KC2 of r22b) */
	const [db, name] = args.positionals as [string, (string | undefined)?]
	const env = args.options["env"] as string | undefined
	const { d1, expected, exported, fts, migrationsDir, pg, provider, target } = await diffTarget(db, env, io)
	/* a diff starts a missing directory, and refuses a file before anything runs (D2-7 of the area D round-two review) */
	refuseNoDir(migrationsDir, { allowMissing: true })
	/* Atlas diffs on the dev database (AD9 of the area D review) */
	if (target?.provider.type === "postgres") refuseBlank(target, { devUrl: target.provider.devUrl })
	/* every peer the diff needs, Atlas and a declared FTS's ts-morph among them, before Atlas or drizzle-kit runs (K1 of r21, KC3 of r22) */
	const peers = needPeers(io, "diff", { fts: fts !== undefined, provider })
	/* after the peers, since a drizzle config imports drizzle-kit; before drizzle-kit exports none of the other dialect's tables (KC1 of r22b) */
	checkDialect(exported.configPath, await statedDialect(exported.configPath), expected)
	const { exportWith, generateIncrementalMigration } = await import("../migrate/core/atlas.ts")
	/* a D1 diff writes beside the files wrangler runs, refused where it would run them otherwise than Atlas (S4, C8) */
	if (d1 && fs.existsSync(migrationsDir)) (await import("../migrate/core/d1-files.ts")).d1Files(migrationsDir)
	const dialect = exported.dialect
	const dryRun = args.options["dry-run"] === true
	/* a Postgres diff reads the history and the export as the statements Postgres runs (M75) */
	if (dialect === "postgres") await (await import("../migrate/core/pg-parser.ts")).loadPostgresParser()
	await diffIn(migrationsDir, dryRun, async (dir) => {
		const { files, notices, synced } = await generateIncrementalMigration({
			dialect,
			ftsSql: fts === undefined ? undefined : await ftsSql(io.cwd, fts, io),
			migrationName: name ?? `migration_${Date.now()}`,
			migrationsDir: dir,
			readyDev: io.readyPgDev,
			run: io.run,
			target: pg,
			targetSchema: exportWith(binOf(peers, "drizzle-kit"), exported),
		})
		/* Atlas OSS may say it left part of the schema out of the diff (plan 14's 5.4) */
		for (const notice of notices) io.err(`Warning: Atlas: ${notice}`)
		if (synced) io.out("Schema is already in sync — no migration needed")
		else if (dryRun) reportDrift(db, files, io)
		else for (const file of files) io.out(`Generated: ${file}`)
	})
}

/**
 * Runs `diff` on the directory it writes in: `migrationsDir` itself, or for a dry run a private
 * copy, since a diff writes its file and rehashes atlas.sum. The copy is empty when there is no
 * directory, and removed however the copying or the diff ends (D2-7 of the area D round-two review).
 */
async function diffIn(migrationsDir: string, dryRun: boolean, diff: (dir: string) => Promise<void>): Promise<void> {
	if (!dryRun) return diff(migrationsDir)
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), "comb-migrate-dry-run-"))
	try {
		if (fs.existsSync(migrationsDir)) fs.cpSync(migrationsDir, copy, { recursive: true })
		await diff(copy)
	} finally {
		fs.rmSync(copy, { force: true, recursive: true })
	}
}

// lookup-table: the drizzle config names a project without a configured one is looked up by, in order
const DRIZZLE_CONFIGS = ["drizzle.config.ts", "drizzle.config.js", "drizzle.config.mjs", "drizzle.config.json"]

/**
 * The drizzle config a diff exports with: the database's, which must exist, else the first of
 * DRIZZLE_CONFIGS in `cwd`; refused before drizzle-kit runs, whose own lookup names a file `init`
 * never writes (K21 of the 0.15.0 review)
 */
function drizzleConfig(configured: string | undefined, cwd: string): string {
	if (configured !== undefined) {
		if (!fs.existsSync(configured)) throw new CliError(`drizzleConfigPath ${configured} does not exist`)
		if (!fs.statSync(configured).isFile())
			throw new CliError(`drizzleConfigPath ${configured} is a directory, not a drizzle config`)
		return configured
	}
	const found = DRIZZLE_CONFIGS.map((name) => path.join(cwd, name)).find((file) => fs.existsSync(file))
	if (found !== undefined) return found
	throw new CliError(
		`no drizzle config in ${cwd} (drizzle.config.ts, .js, .mjs or .json): run comb migrate init, or set drizzleConfigPath on the database in comb.migrate.config.ts`,
	)
}

/* without comb.migrate.config.ts the migrations are SQLite's, whose diff needs what a D1 one does */
const providerOf = (target: MigrateTarget | undefined) => target?.provider.type ?? "d1"

/** What a diff of `db` reads: its Postgres provider if it has one, its drizzle export, the FTS it declares, and its migrations */
async function diffTarget(db: string, env: string | undefined, io: CliContext) {
	const target = await resolveMigrateTarget({ cwd: io.cwd, db, env, mode: "diff" })
	const pg = target?.provider.type === "postgres" ? target.provider : undefined
	const exported = {
		configPath: drizzleConfig(target?.drizzleConfigPath, io.cwd),
		cwd: io.cwd,
		dialect: pg === undefined ? "sqlite" : "postgres",
		run: io.run,
		schema: pg?.schema,
	} as const
	/* the codegen database a migrate database maps to; a name with no mapping says how to give one (C7) */
	const codegen = {
		hint:
			target === undefined || target.codegen !== target.database
				? undefined
				: `Set codegen: "<its comb.config.ts name>" on ${target.database} in comb.migrate.config.ts`,
		name: target?.codegen ?? db,
	}
	const name = DIALECT_NAMES[exported.dialect]
	/* the dialect its drizzle config must state (KC1 of r22b) */
	const expected: Expected =
		target === undefined
			? { but: "a diff with no comb.migrate.config.ts is SQLite", dialect: "sqlite" }
			: {
					but: `database ${db} is ${name}`,
					dialect: exported.dialect,
					otherwise: `, or set drizzleConfigPath on ${db} in comb.migrate.config.ts to a ${name} drizzle config`,
				}
	return {
		d1: target?.provider.type === "d1",
		expected,
		exported,
		/* Postgres has no FTS of comb's: its diff never reads comb.config.ts */
		fts: pg === undefined ? await declaredFts(io.cwd, codegen) : undefined,
		migrationsDir: target?.migrationsDir ?? path.resolve(io.cwd, "atlas-migrations"),
		pg,
		provider: providerOf(target),
		target,
	}
}

/** Print the files a diff would write, and fail: the schema drifted from the migrations */
function reportDrift(db: string, files: readonly string[], io: CliContext): never {
	for (const file of files) {
		io.out(`-- ${path.basename(file)}`)
		io.out(fs.readFileSync(file, "utf8"))
	}
	throw new CliError(`${db} has drifted from its migrations: comb migrate diff ${db} would write the SQL above`)
}

export async function cmdMigrate(argv: readonly string[], io: CliContext, help: string): Promise<void> {
	const [command, ...rest] = argv
	switch (command) {
		/* a bare migrate names no command: it fails, with the commands to pick from (K19) */
		case undefined:
			throw new CliError(help)
		case "help":
		case "-h":
		case "--help":
			refuseFurther(rest, `migrate ${command}`)
			io.out(help)
			return
		case "init":
			migrateInit(rest, io)
			return
		case "diff":
			await migrateDiff(rest, io)
			return
		case "apply":
		case "baseline":
		case "check":
		case "status":
			await migrateApply(command, rest, io)
			return
		default:
			throw new CliError(`Unknown migrate command: ${command}`)
	}
}
