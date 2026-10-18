/**
 * `comb migrate apply` and `baseline`. The database comes from comb.migrate.config.ts (its
 * environment from -e) when the project has one, else it is the D1 database named on the command
 * line. Each migration not yet recorded is classified against the schema the earlier files leave,
 * approved as its safety needs (unsafe: a yes on a terminal or `-- comb:allow-unsafe: <reason>` in
 * the file; cautious: --yes too), and applied in one batch with the record of its hash, so it is
 * applied and recorded or neither.
 */
import fs from "node:fs"
import path from "node:path"
import { checkMigrationHash, ensureMigrationsTable, recordMigrationHash } from "../migrate/core/apply.ts"
import { approveMigration } from "../migrate/core/approval.ts"
import { extractSchema, migrationHashes, parseMigration } from "../migrate/core/parse.ts"
import { withRetry } from "../migrate/core/utils.ts"
import type { Connection, ExtractedSchema } from "../migrate/types.ts"
import { parseArgs, type ParsedArgs } from "./args.ts"
import { resolveMigrateTarget } from "./migrate-target.ts"
import { CliError, type CliIo } from "./output.ts"

type Mode = "apply" | "baseline"

/** An open database to migrate: its connection, its migrations, and how to name it */
type Target = { conn: Connection; migrationsDir: string; name: string }

/** One apply or baseline run: what it was asked, and where it reports */
type Request = { args: ParsedArgs; db: string; io: CliIo; mode: Mode }

const option = (args: ParsedArgs, name: string) => args.options[name] as string | undefined

/** The database comb.migrate.config.ts declares as `db`, in the environment -e names */
async function configuredTarget({ args, db, io, mode }: Request): Promise<Target | undefined> {
	const target = await resolveMigrateTarget({
		cwd: io.cwd,
		db,
		dir: option(args, "dir"),
		env: option(args, "env"),
		mode: "apply",
	})
	if (target === undefined) return undefined
	if (args.options["local"])
		throw new CliError("--local applies without comb.migrate.config.ts; set local: true on its d1 provider")
	if (target.provider.type === "postgres")
		throw new CliError(`${target.label} is a Postgres database, which migrate ${mode} does not apply yet`)
	const { createProvider } = await import("../migrate/config.ts")
	const migrationsDir = requireDir(target.migrationsDir, args)
	const conn = await createProvider(target.provider, { run: io.run }).connect({
		drizzleConfigPath: target.drizzleConfigPath,
		migrationsDir,
		name: target.name,
		provider: target.provider,
	})
	return { conn, migrationsDir, name: target.label }
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
	return (await configuredTarget(request)) ?? d1Target(request)
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

/** A migration file to apply, with the schema the files before it leave */
type Pending = { before: ExtractedSchema; file: string }

const RECORD = "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"

/**
 * Apply one migration, classified against `before`, the schema the earlier files leave: approved
 * as its safety needs (approval.ts), then its statements and record in one batch
 */
async function applyFile({ before, file }: Pending, target: Target, request: Request): Promise<void> {
	const { args, io } = request
	const migration = parseMigration(fs.readFileSync(file, "utf8"), path.basename(file), { before, dialect: "sqlite" })
	const approval = await approveMigration(migration, {
		confirm: io.confirm,
		target: target.name,
		yes: args.options["yes"] === true,
	})
	if (!approval.ok) throw new CliError(approval.message)
	if (approval.approvedBy !== undefined) io.out(`Approved in ${migration.filename}: ${approval.approvedBy}`)
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
	/* the schema every earlier file leaves, applied now or before, which a file is read against */
	let schema = extractSchema("")
	for (const file of files) {
		const sql = fs.readFileSync(file, "utf8")
		const before = schema
		schema = extractSchema(sql, before)
		if (await checkMigrationHash(target.conn, migrationHashes(sql))) {
			if (mode === "apply") io.out(`Skip (already applied): ${path.basename(file)}`)
			continue
		}
		if (mode === "apply") await applyFile({ before, file }, target, request)
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
