/**
 * `comb migrate apply` and `baseline`. The database comes from comb.migrate.config.ts (its
 * environment from -e) when the project has one, else it is the D1 database named on the command
 * line. Each migration not yet recorded is classified, confirmed when it drops something, and
 * applied in one batch with the record of its hash, so it is applied and recorded or neither.
 */
import fs from "node:fs"
import path from "node:path"
import { checkMigrationHash, ensureMigrationsTable, recordMigrationHash } from "../migrate/core/apply.ts"
import { migrationHashes, parseMigration } from "../migrate/core/parse.ts"
import { confirmDrops, withRetry } from "../migrate/core/utils.ts"
import type { Connection } from "../migrate/types.ts"
import { parseArgs, type ParsedArgs } from "./args.ts"
import { CliError, type CliIo } from "./output.ts"

type Mode = "apply" | "baseline"

/** An open database to migrate: its connection, its migrations, and how to name it */
type Target = { conn: Connection; migrationsDir: string; name: string }

/** One apply or baseline run: what it was asked, and where it reports */
type Request = { args: ParsedArgs; db: string; io: CliIo; mode: Mode }

const option = (args: ParsedArgs, name: string) => args.options[name] as string | undefined

/** The database comb.migrate.config.ts declares as `db`, in the environment -e names */
async function configuredTarget(configFile: string, { args, db, io }: Request): Promise<Target> {
	const { createProvider, loadConfig, resolveDatabaseConfig } = await import("../migrate/config.ts")
	if (args.options["local"])
		throw new CliError("--local applies without comb.migrate.config.ts; set local: true on its d1 provider")
	const { config, configDir } = await loadConfig(configFile, io.cwd)
	if (!Object.hasOwn(config.databases, db)) {
		throw new CliError(
			`${path.basename(configFile)} declares no database "${db}". Available: ${Object.keys(config.databases).join(", ")}`,
		)
	}
	const resolved = resolveDatabaseConfig(config.databases[db] as (typeof config.databases)[string], option(args, "env"))
	const migrationsDir = requireDir(path.resolve(configDir, option(args, "dir") ?? resolved.migrationsDir), args)
	const conn = await createProvider(resolved.provider, { run: io.run }).connect({ ...resolved, migrationsDir })
	return { conn, migrationsDir, name: `${db} (${resolved.name})` }
}

/** `dir`, checked before any connection opens; --file needs no directory */
function requireDir(dir: string, args: ParsedArgs): string {
	if (option(args, "file") === undefined && !fs.existsSync(dir)) throw new CliError(`Migrations dir not found: ${dir}`)
	return dir
}

/** The D1 database named `db`, remote unless --local, when the project has no migrate config */
async function d1Target({ args, db, io }: Request): Promise<Target> {
	if (option(args, "env") !== undefined)
		throw new CliError("-e/--env needs comb.migrate.config.ts to define environments")
	const { createD1Provider } = await import("../migrate/drivers/d1.ts")
	const provider = { databaseId: db, databaseName: db, local: args.options["local"] === true, type: "d1" } as const
	const migrationsDir = requireDir(path.resolve(io.cwd, option(args, "dir") ?? "atlas-migrations"), args)
	const conn = await createD1Provider(provider, io.run).connect({ migrationsDir, name: db, provider })
	return { conn, migrationsDir, name: db }
}

async function openTarget(request: Request): Promise<Target> {
	const { findConfigFile } = await import("../migrate/config.ts")
	const configFile = findConfigFile(request.io.cwd)
	return configFile ? configuredTarget(configFile, request) : d1Target(request)
}

/** The migration files to run: --file alone, else every .sql file in the directory, in name order */
function migrationFiles(target: Target, args: ParsedArgs, io: CliIo): string[] {
	const single = option(args, "file")
	if (single !== undefined) return [path.resolve(io.cwd, single)]
	return fs
		.readdirSync(target.migrationsDir)
		.filter((file) => file.endsWith(".sql"))
		.sort()
		.map((file) => path.join(target.migrationsDir, file))
}

const RECORD = "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"

/** Apply one migration: confirmed when it drops something, then its statements and record in one batch */
async function applyFile(file: string, target: Target, { args, io }: Request): Promise<void> {
	const migration = parseMigration(fs.readFileSync(file, "utf8"), path.basename(file))
	const destructive = [...new Set([...migration.drops, ...migration.classification.unsafeStatements])]
	const allowed = await confirmDrops(destructive, target.name, {
		autoConfirm: args.options["yes"] === true,
		confirm: io.confirm,
	})
	if (!allowed) {
		throw new CliError(
			`${migration.filename} is destructive (${destructive.join("; ")}); pass --yes or confirm it on a terminal`,
		)
	}
	io.out(`Apply: ${migration.filename}`)
	const statements = [
		...migration.statements.map((sql) => ({ sql })),
		{ params: [migration.hash, Date.now()], sql: RECORD },
	]
	await withRetry(() => target.conn.batch(statements))
}

/** Each file not yet recorded: applied (apply) or only recorded (baseline); returns how many */
async function runFiles(
	files: readonly string[],
	target: Target,
	request: Request,
): Promise<{ done: number; skipped: number }> {
	const { io, mode } = request
	let done = 0
	for (const file of files) {
		const sql = fs.readFileSync(file, "utf8")
		if (await checkMigrationHash(target.conn, migrationHashes(sql))) {
			if (mode === "apply") io.out(`Skip (already applied): ${path.basename(file)}`)
			continue
		}
		if (mode === "apply") await applyFile(file, target, request)
		else {
			await recordMigrationHash(target.conn, migrationHashes(sql)[0] as string)
			io.out(`Marked applied: ${path.basename(file)}`)
		}
		done++
	}
	return { done, skipped: files.length - done }
}

export async function migrateApply(mode: Mode, argv: readonly string[], io: CliIo): Promise<void> {
	const args = parseArgs(argv, `migrate ${mode}`)
	const [db] = args.positionals
	if (db === undefined || args.positionals.length > 1) {
		throw new CliError(
			`Usage: comb migrate ${mode} <database> [-e <env>] [--dir <path>]${mode === "apply" ? " [--file <path>] [--yes]" : ""} [--local]`,
		)
	}
	const request: Request = { args, db, io, mode }
	const target = await openTarget(request)
	try {
		const files = migrationFiles(target, args, io)
		await ensureMigrationsTable(target.conn)
		const { done, skipped } = await runFiles(files, target, request)
		io.out(
			mode === "apply"
				? `\nDone: ${done} applied, ${skipped} skipped`
				: `\nBaseline done: ${done} marked, ${skipped} already tracked`,
		)
	} finally {
		await target.conn.close()
	}
}
