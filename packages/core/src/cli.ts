#!/usr/bin/env bun
/**
 * Comb CLI — database codegen + migration toolkit
 *
 * Usage:
 *   bunx comb codegen [db] [-g generator]    Run codegen from comb.config.ts
 *   bunx comb codegen --tables <path>        Direct mode (no config)
 *   bunx comb migrate diff <db> [name]       Generate migration from schema diff
 *   bunx comb migrate apply <db> <file>      Apply specific migration
 *   bunx comb migrate init <db>              Generate drizzle.config.ts + atlas.hcl
 */
import fs from "node:fs"
import path from "node:path"

const HELP = `
comb — database codegen + migration toolkit

COMMANDS:
  codegen [db] [-g gen]          Run codegen (uses comb.config.ts)
  codegen --tables <path>        Direct mode (analyze + generate)
  migrate diff <db> [name]       Schema diff -> migration SQL
  migrate apply <db> <file>      Apply migration to database
  migrate init                   Generate drizzle.config.ts + atlas.hcl

OPTIONS:
  -g, --generator <name>         Run specific generator only
  -e, --env <name>               Environment (local|dev|prod)
  --tables <path>                Tables file path (direct mode)
  --yes, -y                      Auto-confirm destructive changes
  --help                         Show this help
`

type OrmDriver = "bun-sqlite" | "d1" | "libsql" | "neon" | "node-postgres" | "postgres-js" | "turso"

type FtsTableConfig = {
	columns: string[]
	tokenizer?: string
}

type CodegenConfig = {
	databases: Record<
		string,
		{
			dialect?: "sqlite" | "postgres"
			driver?: OrmDriver
			filePrefix?: string
			fts?: Record<string, FtsTableConfig>
			generators?: string[]
			output?: Record<string, string>
			tables: string
		}
	>
}

async function loadCombConfig(cwd: string): Promise<CodegenConfig> {
	const candidates = ["comb.config.ts", "comb.config.js"]
	for (const name of candidates) {
		const fp = path.resolve(cwd, name)
		if (fs.existsSync(fp)) {
			const mod = (await import(fp)) as { default?: CodegenConfig }
			return mod.default ?? (mod as unknown as CodegenConfig)
		}
	}
	throw new Error("No comb.config.ts found. Create one or use --tables <path> for direct mode.")
}

async function cmdCodegen(args: string[]): Promise<void> {
	const cwd = process.cwd()

	/* Parse args */
	let dbName: string | undefined
	let generator: string | undefined
	let tablesPath: string | undefined

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "-g" || arg === "--generator") {
			generator = args[++i]
		} else if (arg === "--tables") {
			tablesPath = args[++i]
		} else if (!arg?.startsWith("-")) {
			dbName = arg
		}
	}

	/* Direct mode: --tables flag */
	if (tablesPath) {
		const resolvedTables = path.resolve(cwd, tablesPath)
		if (!fs.existsSync(resolvedTables)) {
			console.error(`Tables file not found: ${resolvedTables}`)
			process.exit(1)
		}
		await runCodegenDirect(resolvedTables, cwd, generator)
		return
	}

	/* Config mode */
	const config = await loadCombConfig(cwd)
	const dbNames = dbName ? [dbName] : Object.keys(config.databases)

	for (const name of dbNames) {
		const dbConfig = config.databases[name]
		if (!dbConfig) {
			console.error(`Database "${name}" not found in config. Available: ${Object.keys(config.databases).join(", ")}`)
			process.exit(1)
		}

		const resolvedTables = path.resolve(cwd, dbConfig.tables)
		if (!fs.existsSync(resolvedTables)) {
			console.error(`Tables file not found: ${resolvedTables}`)
			process.exit(1)
		}

		console.log(`\nCodegen: ${name}`)
		await runCodegenForDb(name, dbConfig, resolvedTables, cwd, generator)
	}
}

async function runCodegenDirect(tablesPath: string, cwd: string, generator?: string): Promise<void> {
	const { analyze } = await import("./codegen/analyzer.ts")
	const { validateTables } = await import("./codegen/utils/validate.ts")

	/* Validate */
	const validation = validateTables(tablesPath)
	if (validation.errors.length > 0) {
		console.error("Validation errors:")
		for (const e of validation.errors) console.error(`  ${e}`)
		process.exit(1)
	}
	for (const w of validation.warnings) console.warn(`  warn: ${w}`)

	/* Analyze */
	const analysis = analyze(tablesPath, cwd)
	console.log(`Analyzed ${analysis.tables.length} tables (${analysis.dbName})`)

	const shouldRun = (g: string) => !generator || generator === g

	const tablesDir = path.dirname(tablesPath)

	if (shouldRun("constraints")) {
		const { generateConstraints } = await import("./codegen/generators/constraints.ts")
		generateConstraints(
			analysis.tables,
			analysis.dbName,
			{ output: path.join(tablesDir, `db.${analysis.dbName}.constraints.gen.ts`) },
			tablesDir,
		)
	}

	if (shouldRun("rows")) {
		const { generateRows } = await import("./codegen/generators/rows.ts")
		generateRows(
			analysis.tables,
			tablesPath,
			{ output: path.join(tablesDir, `db.${analysis.dbName}.rows.gen.ts`) },
			tablesDir,
		)
	}

	if (shouldRun("relations")) {
		const { generateRelations } = await import("./codegen/generators/relations.ts")
		generateRelations(
			analysis.tables,
			tablesPath,
			{ output: path.join(tablesDir, `db.${analysis.dbName}.relations.gen.ts`) },
			tablesDir,
		)
	}

	if (shouldRun("diagrams")) {
		const { generateDiagrams } = await import("./codegen/generators/diagrams.ts")
		generateDiagrams(
			{ dbName: analysis.dbName, tables: analysis.tables },
			{ output: path.join(tablesDir, "diagrams") },
			tablesDir,
		)
	}

	if (shouldRun("columns")) {
		const { generateColumns } = await import("./codegen/generators/columns.ts")
		generateColumns(analysis.tables, tablesPath, { output: tablesDir }, tablesDir)
	}

	if (shouldRun("dtos")) {
		const { generateDtos } = await import("./codegen/generators/dtos.ts")
		generateDtos(analysis, tablesPath, { output: path.join(tablesDir, "dtos") }, tablesDir)
	}

	if (shouldRun("entities")) {
		const { generateEntities } = await import("./codegen/generators/entities.ts")
		generateEntities(
			analysis.tables,
			analysis.dbName,
			{
				output: path.join(tablesDir, `db.${analysis.dbName}.entities.gen.ts`),
				updatePackageJson: true,
			},
			tablesDir,
		)
	}

	if (shouldRun("manifest")) {
		const { generateManifest } = await import("./codegen/generators/manifest.ts")
		generateManifest(
			analysis.tables,
			analysis.dbName,
			{ output: path.join(tablesDir, `db.${analysis.dbName}.manifest.gen.json`) },
			tablesDir,
		)
	}

	if (shouldRun("enum-checks")) {
		const { generateEnumChecks } = await import("./codegen/generators/enum-checks.ts")
		generateEnumChecks(
			analysis.tables,
			analysis.dbName,
			{ output: path.join(tablesDir, `db.${analysis.dbName}.enum-checks.gen.ts`) },
			tablesDir,
		)
	}
}

async function runCodegenForDb(
	dbName: string,
	dbConfig: NonNullable<CodegenConfig["databases"][string]>,
	tablesPath: string,
	cwd: string,
	generator?: string,
): Promise<void> {
	const { analyze } = await import("./codegen/analyzer.ts")
	const { validateTables } = await import("./codegen/utils/validate.ts")

	const validation = validateTables(tablesPath)
	if (validation.errors.length > 0) {
		console.error("Validation errors:")
		for (const e of validation.errors) console.error(`  ${e}`)
		process.exit(1)
	}
	for (const w of validation.warnings) console.warn(`  warn: ${w}`)

	const analysis = analyze(tablesPath, cwd)
	console.log(`  ${analysis.tables.length} tables`)

	const generators = new Set(
		dbConfig.generators ?? [
			"columns",
			"constraints",
			"diagrams",
			"dtos",
			"entities",
			"enum-checks",
			"field-names",
			"fts",
			"manifest",
			"orm",
			"relations",
			"rows",
			"translations",
		],
	)
	const shouldRun = (g: string) => generators.has(g) && (!generator || generator === g)
	const output = dbConfig.output ?? {}
	const tablesDir = path.dirname(tablesPath)
	const fp = dbConfig.filePrefix ?? `db.${dbName}`

	if (shouldRun("constraints")) {
		const { generateConstraints } = await import("./codegen/generators/constraints.ts")
		generateConstraints(
			analysis.tables,
			analysis.dbName,
			{ output: output["constraints"] ?? path.join(tablesDir, `${fp}.constraints.gen.ts`) },
			cwd,
		)
	}

	if (shouldRun("rows")) {
		const { generateRows } = await import("./codegen/generators/rows.ts")
		generateRows(
			analysis.tables,
			tablesPath,
			{ output: output["rows"] ?? path.join(tablesDir, `${fp}.rows.gen.ts`) },
			cwd,
		)
	}

	if (shouldRun("relations")) {
		const { generateRelations } = await import("./codegen/generators/relations.ts")
		generateRelations(
			analysis.tables,
			tablesPath,
			{ output: output["relations"] ?? path.join(tablesDir, `${fp}.relations.gen.ts`) },
			cwd,
		)
	}

	if (shouldRun("diagrams")) {
		const { generateDiagrams } = await import("./codegen/generators/diagrams.ts")
		generateDiagrams(
			{ dbName: analysis.dbName, tables: analysis.tables },
			{ output: output["diagrams"] ?? path.join(tablesDir, "diagrams") },
			cwd,
		)
	}

	if (shouldRun("columns")) {
		const { generateColumns } = await import("./codegen/generators/columns.ts")
		generateColumns(
			analysis.tables,
			tablesPath,
			{ filePrefix: dbConfig.filePrefix, output: output["columns"] ?? tablesDir, updatePackageJson: true },
			cwd,
		)
	}

	if (shouldRun("dtos")) {
		const { generateDtos } = await import("./codegen/generators/dtos.ts")
		generateDtos(
			analysis,
			tablesPath,
			{
				filePrefix: dbConfig.filePrefix,
				output: output["dtos"] ?? path.join(tablesDir, "dtos"),
				updatePackageJson: true,
			},
			cwd,
		)
	}

	if (shouldRun("entities")) {
		const { generateEntities } = await import("./codegen/generators/entities.ts")
		generateEntities(
			analysis.tables,
			analysis.dbName,
			{
				output: output["entities"] ?? path.join(tablesDir, `${fp}.entities.gen.ts`),
				updatePackageJson: true,
			},
			cwd,
		)
	}

	if (shouldRun("manifest")) {
		const { generateManifest } = await import("./codegen/generators/manifest.ts")
		generateManifest(
			analysis.tables,
			analysis.dbName,
			{ output: output["manifest"] ?? path.join(tablesDir, `${fp}.manifest.gen.json`) },
			cwd,
		)
	}

	if (shouldRun("field-names")) {
		const { generateFieldNames } = await import("./codegen/generators/field-names.ts")
		generateFieldNames(
			analysis.tables,
			analysis.dbName,
			{
				output: output["field-names"] ?? path.join(tablesDir, `${fp}.field-names.gen.ts`),
				updatePackageJson: true,
			},
			cwd,
		)
	}

	if (shouldRun("orm") && dbConfig.dialect && dbConfig.driver) {
		const { generateOrm } = await import("./codegen/generators/orm.ts")
		generateOrm(
			tablesPath,
			{
				dialect: dbConfig.dialect,
				driver: dbConfig.driver,
				filePrefix: dbConfig.filePrefix,
				output: output["orm"] ?? path.join(tablesDir, `${fp}.orm.gen.ts`),
			},
			cwd,
		)
	}

	if (shouldRun("enum-checks")) {
		const { generateEnumChecks } = await import("./codegen/generators/enum-checks.ts")
		generateEnumChecks(
			analysis.tables,
			analysis.dbName,
			{
				output: output["enum-checks"] ?? path.join(tablesDir, `${fp}.enum-checks.gen.ts`),
			},
			cwd,
		)
	}

	if (shouldRun("translations")) {
		const constraintsPath = output["constraints"] ?? path.join(tablesDir, `${fp}.constraints.gen.ts`)
		if (fs.existsSync(path.resolve(cwd, constraintsPath))) {
			const { generateTranslations } = await import("./codegen/generators/translations.ts")
			generateTranslations(path.resolve(cwd, constraintsPath), { baseDir: tablesDir }, cwd)
		}
	}

	if (shouldRun("fts") && dbConfig.fts && Object.keys(dbConfig.fts).length > 0) {
		const { generateFts } = await import("./codegen/generators/fts.ts")
		generateFts(
			analysis.tables,
			dbName,
			{
				fts: dbConfig.fts,
				output: output["fts"] ?? tablesDir,
			},
			cwd,
		)
	}
}

function cmdMigrateInit(cwd: string): void {
	const dialect = "sqlite"

	const drizzleConfigPath = path.join(cwd, "drizzle.config.ts")
	if (!fs.existsSync(drizzleConfigPath)) {
		fs.writeFileSync(
			drizzleConfigPath,
			`import { defineConfig } from "drizzle-kit"\n\nexport default defineConfig({\n\tdialect: "${dialect}",\n\tout: "./atlas-migrations",\n\tschema: "./src/**/*.tables.ts",\n})\n`,
		)
		console.log("Created: drizzle.config.ts")
	}

	const atlasHclPath = path.join(cwd, "atlas.hcl")
	if (!fs.existsSync(atlasHclPath)) {
		fs.writeFileSync(
			atlasHclPath,
			`variable "db_url" {\n  type = string\n}\n\ndata "external_schema" "drizzle" {\n  program = [\n    "bun",\n    "drizzle-kit",\n    "export"\n  ]\n}\n\nenv "local" {\n  src = data.external_schema.drizzle.url\n  url = var.db_url\n  dev = "${dialect}://file?mode=memory"\n\n  migration {\n    dir = "file://atlas-migrations"\n  }\n\n  diff {\n    skip {\n      drop_schema = true\n      drop_table  = true\n    }\n  }\n}\n`,
		)
		console.log("Created: atlas.hcl")
	}

	const migrationsDir = path.join(cwd, "atlas-migrations")
	if (!fs.existsSync(migrationsDir)) {
		fs.mkdirSync(migrationsDir, { recursive: true })
		console.log("Created: atlas-migrations/")
	}
}

async function cmdMigrate(args: string[]): Promise<void> {
	const command = args[0]

	if (!command || command === "help" || command === "--help") {
		console.log(`
comb migrate — database migration toolkit

COMMANDS:
  init                              Generate drizzle.config.ts + atlas.hcl
  diff <db> [name]                  Generate incremental migration from schema diff
  apply <d1-name> [--dir <path>]    Apply pending migrations to a D1 database (tracked via __drizzle_migrations)
  apply <d1-name> --file <path>     Apply a single migration file (still hash-tracked)
  baseline <d1-name> [--dir <path>] Record all migrations in the dir as applied WITHOUT running their SQL

OPTIONS:
  --dir <path>                      Migrations directory (default: ./atlas-migrations)
  --file <path>                     Single migration file to apply
`)
		return
	}

	const cwd = process.cwd()

	if (command === "init") {
		await cmdMigrateInit(cwd)
		return
	}

	if (command === "diff") {
		const { checkAtlasInstalled, exportDrizzleSchema, generateIncrementalMigration } =
			await import("./migrate/core/atlas.ts")

		if (!checkAtlasInstalled()) {
			console.error("Atlas not found. Install: https://atlasgo.io/getting-started")
			process.exit(1)
		}

		let targetSchema = exportDrizzleSchema({ cwd, dialect: "sqlite" })

		/* Append FTS SQL if config has fts — treated as part of the target schema */
		try {
			const config = await loadCombConfig(cwd)
			const dbName = args[1]
			const dbConfig = dbName ? config.databases[dbName] : undefined
			if (dbConfig?.fts && Object.keys(dbConfig.fts).length > 0) {
				const { analyze } = await import("./codegen/analyzer.ts")
				const { generateFtsSql } = await import("./codegen/generators/fts-sql.ts")
				const resolvedTables = path.resolve(cwd, dbConfig.tables)
				const analysis = analyze(resolvedTables, cwd)
				const ftsSql = generateFtsSql(analysis.tables, dbConfig.fts)
				if (ftsSql) {
					targetSchema = `${targetSchema}\n\n/* — FTS5 virtual tables — */\n\n${ftsSql}`
				}
			}
		} catch {
			/* No comb config or no fts — proceed without FTS */
		}

		const migrationName = args[2] ?? `migration_${Date.now()}`
		const migrationsDir = path.resolve(cwd, "atlas-migrations")

		const { files, synced } = generateIncrementalMigration({
			dialect: "sqlite",
			migrationName,
			migrationsDir,
			targetSchema,
		})

		if (synced) {
			console.log("Schema is already in sync — no migration needed")
			return
		}

		for (const f of files) console.log(`Generated: ${f}`)
		return
	}

	if (command === "apply") {
		/* apply <d1-database-name> [--dir <path>] [--file <path>]
		   Applies every unapplied migration in the directory, idempotently tracked
		   via __drizzle_migrations on the target DB. */
		const dbName = args[1]
		if (!dbName || dbName.startsWith("-")) {
			console.error("Usage: comb migrate apply <d1-database-name> [--dir <path>] [--file <path>]")
			process.exit(1)
		}

		let migrationsDirArg: string | undefined
		let singleFile: string | undefined
		for (let i = 2; i < args.length; i++) {
			const arg = args[i]
			if (arg === "--dir") migrationsDirArg = args[++i]
			else if (arg === "--file") singleFile = args[++i]
		}

		const migrationsDir = path.resolve(cwd, migrationsDirArg ?? "atlas-migrations")
		if (!fs.existsSync(migrationsDir)) {
			console.error(`Migrations dir not found: ${migrationsDir}`)
			process.exit(1)
		}

		const { createD1Provider } = await import("./migrate/drivers/d1.ts")
		const { checkMigrationHash, ensureMigrationsTable, recordMigrationHash } = await import("./migrate/core/apply.ts")
		const { generateMigrationHash } = await import("./migrate/core/parse.ts")

		const provider = createD1Provider({ databaseId: dbName, databaseName: dbName, type: "d1" })
		const conn = await provider.connect({
			migrationsDir,
			name: dbName,
			provider: { databaseId: dbName, databaseName: dbName, type: "d1" },
		})

		try {
			await ensureMigrationsTable(conn)

			const allFiles = singleFile
				? [path.isAbsolute(singleFile) ? singleFile : path.resolve(cwd, singleFile)]
				: fs
						.readdirSync(migrationsDir)
						.filter((f) => f.endsWith(".sql") && f !== "atlas.sum")
						.sort()
						.map((f) => path.join(migrationsDir, f))

			let applied = 0
			let skipped = 0
			for (const file of allFiles) {
				const sql = fs.readFileSync(file, "utf-8")
				const hash = generateMigrationHash(sql)
				if (await checkMigrationHash(conn, hash)) {
					console.log(`Skip (already applied): ${path.basename(file)}`)
					skipped++
					continue
				}
				console.log(`Apply: ${path.basename(file)}`)
				await conn.batch([{ sql }])
				await recordMigrationHash(conn, hash)
				applied++
			}

			console.log(`\nDone: ${applied} applied, ${skipped} skipped`)
		} finally {
			await conn.close()
		}
		return
	}

	if (command === "baseline") {
		/* baseline <d1-database-name> [--dir <path>]
		   Records every migration file in the directory as applied WITHOUT running
		   its SQL. Use this once per prod DB whose schema was set up out-of-band. */
		const dbName = args[1]
		if (!dbName || dbName.startsWith("-")) {
			console.error("Usage: comb migrate baseline <d1-database-name> [--dir <path>]")
			process.exit(1)
		}

		let migrationsDirArg: string | undefined
		for (let i = 2; i < args.length; i++) {
			const arg = args[i]
			if (arg === "--dir") migrationsDirArg = args[++i]
		}

		const migrationsDir = path.resolve(cwd, migrationsDirArg ?? "atlas-migrations")
		if (!fs.existsSync(migrationsDir)) {
			console.error(`Migrations dir not found: ${migrationsDir}`)
			process.exit(1)
		}

		const { createD1Provider } = await import("./migrate/drivers/d1.ts")
		const { checkMigrationHash, ensureMigrationsTable, recordMigrationHash } = await import("./migrate/core/apply.ts")
		const { generateMigrationHash } = await import("./migrate/core/parse.ts")

		const provider = createD1Provider({ databaseId: dbName, databaseName: dbName, type: "d1" })
		const conn = await provider.connect({
			migrationsDir,
			name: dbName,
			provider: { databaseId: dbName, databaseName: dbName, type: "d1" },
		})

		try {
			await ensureMigrationsTable(conn)

			const files = fs
				.readdirSync(migrationsDir)
				.filter((f) => f.endsWith(".sql") && f !== "atlas.sum")
				.sort()

			let marked = 0
			let already = 0
			for (const name of files) {
				const sql = fs.readFileSync(path.join(migrationsDir, name), "utf-8")
				const hash = generateMigrationHash(sql)
				if (await checkMigrationHash(conn, hash)) {
					already++
					continue
				}
				await recordMigrationHash(conn, hash)
				console.log(`Marked applied: ${name}`)
				marked++
			}

			console.log(`\nBaseline done: ${marked} marked, ${already} already tracked`)
		} finally {
			await conn.close()
		}
		return
	}

	console.error(`Unknown migrate command: ${command}`)
	process.exit(1)
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const command = args[0]

	if (!command || command === "--help" || command === "help") {
		console.log(HELP)
		return
	}

	switch (command) {
		case "codegen":
			await cmdCodegen(args.slice(1))
			break
		case "migrate":
			await cmdMigrate(args.slice(1))
			break
		default:
			console.error(`Unknown command: ${command}`)
			console.log(HELP)
			process.exit(1)
	}
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e)
	process.exit(1)
})
