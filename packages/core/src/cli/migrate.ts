/** `comb migrate`: init, diff, check, apply, baseline and status. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "./args.ts"
import { configuredFtsSql } from "./comb-config.ts"
import { migrateApply } from "./migrate-apply.ts"
import { resolveMigrateTarget } from "./migrate-target.ts"
import { CliError, type CliIo } from "./output.ts"

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
function starterFiles(dialect: string): ReadonlyArray<readonly [string, string]> {
	if (dialect === "sqlite") return [["drizzle.config.ts", DRIZZLE_CONFIG]]
	if (dialect !== "postgres") throw new CliError(`Unknown --dialect "${dialect}": use sqlite or postgres`)
	return [
		["drizzle.config.ts", PG_DRIZZLE_CONFIG],
		["comb.migrate.config.ts", PG_MIGRATE_CONFIG],
	]
}

/** Write each starter file of the dialect --dialect names that does not exist yet */
function migrateInit(argv: readonly string[], io: CliIo): void {
	const dialect = parseArgs(argv, "migrate init").options["dialect"]
	for (const [name, content] of starterFiles(typeof dialect === "string" ? dialect : "sqlite")) {
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
async function migrateDiff(argv: readonly string[], io: CliIo): Promise<void> {
	const args = parseArgs(argv, "migrate diff")
	const [db, name] = args.positionals
	const { checkAtlasInstalled, exportDrizzleSchema, generateIncrementalMigration } =
		await import("../migrate/core/atlas.ts")
	if (!checkAtlasInstalled(io.run)) throw new CliError("Atlas not found. Install: https://atlasgo.io/getting-started")
	const { codegen, exported, migrationsDir, pg } = await diffTarget(db, io)
	const dialect = exported.dialect
	const dryRun = args.options["dry-run"] === true
	/* a Postgres diff reads the history and the export as the statements Postgres runs (M75) */
	if (dialect === "postgres") await (await import("../migrate/core/pg-parser.ts")).loadPostgresParser()
	/* a dry run diffs a copy, since a diff writes its file and rehashes atlas.sum */
	const dir = dryRun ? copyOf(migrationsDir) : migrationsDir
	try {
		const { files, synced } = generateIncrementalMigration({
			dialect,
			ftsSql: pg === undefined ? await configuredFtsSql(io.cwd, codegen, io) : undefined,
			migrationName: name ?? `migration_${Date.now()}`,
			migrationsDir: dir,
			run: io.run,
			target: pg,
			targetSchema: exportDrizzleSchema(exported),
		})
		if (synced) io.out("Schema is already in sync — no migration needed")
		else if (dryRun) reportDrift(db, files, io)
		else for (const file of files) io.out(`Generated: ${file}`)
	} finally {
		if (dryRun) fs.rmSync(dir, { force: true, recursive: true })
	}
}

/** What a diff of `db` reads: its Postgres provider if it has one, its drizzle export, and its migrations */
async function diffTarget(db: string | undefined, io: CliIo) {
	const target = db === undefined ? undefined : await resolveMigrateTarget({ cwd: io.cwd, db, mode: "diff" })
	const pg = target?.provider.type === "postgres" ? target.provider : undefined
	const exported = {
		configPath: target?.drizzleConfigPath,
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
	return { codegen, exported, migrationsDir: target?.migrationsDir ?? path.resolve(io.cwd, "atlas-migrations"), pg }
}

/** Print the files a diff would write, and fail: the schema drifted from the migrations */
function reportDrift(db: string | undefined, files: readonly string[], io: CliIo): never {
	for (const file of files) {
		io.out(`-- ${path.basename(file)}`)
		io.out(fs.readFileSync(file, "utf8"))
	}
	throw new CliError(
		db === undefined
			? "the schema has drifted from the migrations: comb migrate diff would write the SQL above"
			: `${db} has drifted from its migrations: comb migrate diff ${db} would write the SQL above`,
	)
}

/** A private copy of the migrations directory, empty when there is none */
function copyOf(dir: string): string {
	const copy = fs.mkdtempSync(path.join(os.tmpdir(), "comb-migrate-dry-run-"))
	if (fs.existsSync(dir)) fs.cpSync(dir, copy, { recursive: true })
	return copy
}

export async function cmdMigrate(argv: readonly string[], io: CliIo, help: string): Promise<void> {
	const [command, ...rest] = argv
	switch (command) {
		case undefined:
		case "help":
		case "--help":
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
