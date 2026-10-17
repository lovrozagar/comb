/** `comb migrate`: init, diff, apply and baseline. */
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "./args.ts"
import { configuredFtsSql } from "./comb-config.ts"
import { migrateApply } from "./migrate-apply.ts"
import { CliError, type CliIo } from "./output.ts"

const DRIZZLE_CONFIG = `import { defineConfig } from "drizzle-kit"

export default defineConfig({
	dialect: "sqlite",
	out: "./atlas-migrations",
	schema: "./src/**/*.tables.ts",
})
`

const ATLAS_HCL = `variable "db_url" {
  type = string
}

data "external_schema" "drizzle" {
  program = [
    "bun",
    "drizzle-kit",
    "export"
  ]
}

env "local" {
  src = data.external_schema.drizzle.url
  url = var.db_url
  dev = "sqlite://file?mode=memory"

  migration {
    dir = "file://atlas-migrations"
  }

  diff {
    skip {
      drop_schema = true
      drop_table  = true
    }
  }
}
`

/** Write each starter file that does not exist yet */
function migrateInit(argv: readonly string[], io: CliIo): void {
	parseArgs(argv, "migrate init")
	for (const [name, content] of [
		["drizzle.config.ts", DRIZZLE_CONFIG],
		["atlas.hcl", ATLAS_HCL],
	] as const) {
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

/** The next migration for `db`: Atlas's diff of the exported schema, plus comb's FTS delta */
async function migrateDiff(argv: readonly string[], io: CliIo): Promise<void> {
	const [db, name] = parseArgs(argv, "migrate diff").positionals
	const { checkAtlasInstalled, exportDrizzleSchema, generateIncrementalMigration } =
		await import("../migrate/core/atlas.ts")
	if (!checkAtlasInstalled(io.run)) throw new CliError("Atlas not found. Install: https://atlasgo.io/getting-started")
	const ftsSql = await configuredFtsSql(io.cwd, db, io)
	const { files, synced } = generateIncrementalMigration({
		dialect: "sqlite",
		ftsSql,
		migrationName: name ?? `migration_${Date.now()}`,
		migrationsDir: path.resolve(io.cwd, "atlas-migrations"),
		run: io.run,
		targetSchema: exportDrizzleSchema({ cwd: io.cwd, dialect: "sqlite", run: io.run }),
	})
	if (synced) io.out("Schema is already in sync — no migration needed")
	for (const file of files) io.out(`Generated: ${file}`)
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
			await migrateApply(command, rest, io)
			return
		default:
			throw new CliError(`Unknown migrate command: ${command}`)
	}
}
