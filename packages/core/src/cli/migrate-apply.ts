/**
 * `comb migrate apply`, `check`, `baseline` and `status`. The database comes from
 * comb.migrate.config.ts (its environment from -e) when the project has one, else it is the D1
 * database named on the command line. Postgres goes through Atlas (migrate-atlas.ts) and D1
 * through wrangler (migrate-d1.ts); the other SQLite databases keep comb's own history,
 * `__drizzle_migrations`. There, `check` runs the check every apply runs first (plan-apply.ts):
 * the sum, the order, and each pending migration classified against the schema the earlier files
 * leave and approved as its safety needs (unsafe: a yes on a terminal or `-- comb:allow-unsafe:
 * <reason>` in the file; cautious: --yes too). `apply` then applies each in one batch with the
 * record of its hash, so it is applied and recorded or neither.
 */
import fs from "node:fs"
import path from "node:path"
import { ensureMigrationsTable, recordMigrationHash } from "../migrate/core/apply.ts"
import { approveMigration } from "../migrate/core/approval.ts"
import { sqlFiles } from "../migrate/core/atlas-dir.ts"
import { sqliteDrift } from "../migrate/core/baseline-compare.ts"
import { migrationHashes } from "../migrate/core/parse.ts"
import { type Pending, planApply } from "../migrate/core/plan-apply.ts"
import { run as runProcess } from "../migrate/core/process.ts"
import { withRetry } from "../migrate/core/utils.ts"
import type { Connection, ConnectionProviderConfig } from "../migrate/types.ts"
import { parseArgs, type ParsedArgs } from "./args.ts"
import { type MigrateTarget, resolveMigrateTarget } from "./migrate-target.ts"
import { checkPassed, CliError, type CliIo, type MigrateOutcome } from "./output.ts"

type Mode = "apply" | "baseline" | "check" | "status"

/** An open database to migrate: its connection, its migrations, and how to name it */
type Target = { conn: Connection; migrationsDir: string; name: string }

/** One command: what it was asked, and where it reports */
type Request = { args: ParsedArgs; db: string; io: CliIo; mode: Mode }

const option = (args: ParsedArgs, name: string) => args.options[name] as string | undefined

/** The SQLite, libsql or Turso database comb.migrate.config.ts resolved, opened */
async function configuredTarget(
	{ args, io }: Request,
	target: MigrateTarget & { provider: ConnectionProviderConfig },
): Promise<Target> {
	if (args.options["local"]) throw new CliError("--local is for a D1 database; set local: true on its d1 provider")
	const { createProvider } = await import("../migrate/config.ts")
	if (option(args, "file") === undefined && !fs.existsSync(target.migrationsDir))
		throw new CliError(`Migrations dir not found: ${target.migrationsDir}`)
	const conn = await createProvider(target.provider, { run: io.run }).connect({
		drizzleConfigPath: target.drizzleConfigPath,
		migrationsDir: target.migrationsDir,
		name: target.name,
		provider: target.provider,
	})
	return { conn, migrationsDir: target.migrationsDir, name: target.label }
}

const RECORD = "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"

/** Apply one checked migration: its statements and its record in one batch */
async function applyPending({ migration }: Pending, target: Target, io: CliIo): Promise<void> {
	io.out(`Apply: ${migration.filename}`)
	const statements = [
		...migration.statements.map((sql) => ({ sql })),
		{ params: [migration.hash, Date.now()], sql: RECORD },
	]
	await withRetry(() => target.conn.batch(statements))
}

/** The hashes `__drizzle_migrations` records */
async function recordedHashes(conn: Connection): Promise<Set<string>> {
	return new Set((await conn.execute("SELECT hash FROM __drizzle_migrations")).rows.map((row) => String(row[0])))
}

/**
 * Record each file not yet recorded, once the database's schema is the one the files leave: comb
 * compares the two (baseline-compare.ts) and refuses any difference, so nothing is recorded as
 * applied that the database does not reflect
 */
/** The files of a directory, and the hashes the database records */
type History = { files: readonly string[]; recorded: ReadonlySet<string> }

async function baseline(target: Target, { files, recorded }: History, io: CliIo) {
	const drift = await sqliteDrift(target.conn, target.migrationsDir, io.run ?? runProcess)
	if (drift !== "") {
		throw new CliError(
			`${target.name}'s schema is not the one its migrations leave, so baseline records nothing; the difference:\n${drift}`,
		)
	}
	let marked = 0
	for (const name of files) {
		const hashes = migrationHashes(fs.readFileSync(path.join(target.migrationsDir, name), "utf8"))
		if (hashes.some((hash) => recorded.has(hash))) continue
		await recordMigrationHash(target.conn, hashes[0] as string)
		io.out(`Marked applied: ${name}`)
		marked++
	}
	io.out(`\nBaseline done: ${marked} marked, ${files.length - marked} already tracked`)
}

/** `request.mode` on a SQLite database whose history is comb's own `__drizzle_migrations` */
async function migrateSqlite({ args, io, mode }: Request, target: Target): Promise<MigrateOutcome> {
	await ensureMigrationsTable(target.conn)
	const recorded = await recordedHashes(target.conn)
	const single = option(args, "file")
	const dir = single === undefined ? target.migrationsDir : path.dirname(path.resolve(io.cwd, single))
	const files = single === undefined ? sqlFiles(dir) : [path.basename(single)]
	if (mode === "baseline") {
		await baseline(target, { files, recorded }, io)
		return { applied: [], pending: [] }
	}
	const yes = args.options["yes"] === true
	const pending = await planApply({
		applied: (_, sql) => migrationHashes(sql).some((hash) => recorded.has(hash)),
		approve: (migration) => approveMigration(migration, { confirm: io.confirm, target: target.name, yes }),
		conn: target.conn,
		dir,
		exec: io.run ?? runProcess,
		files,
		print: io.out,
		whole: single === undefined,
	})
	const names = pending.map(({ name }) => name)
	if (mode === "check") {
		io.out(checkPassed(names))
		return { applied: [], pending: names }
	}
	for (const name of files.filter((file) => !names.includes(file))) io.out(`Skip (already applied): ${name}`)
	for (const each of pending) await applyPending(each, target, io)
	io.out(`\nDone: ${names.length} applied, ${files.length - names.length} skipped`)
	return { applied: names, pending: [] }
}

/** A mode's usage line: apply takes --file and --yes, check --yes, and every mode but status --local */
function usage(mode: Mode): string {
	const flags = {
		apply: " [--file <path>] [--yes] [--local]",
		baseline: " [--local]",
		check: " [--yes] [--local]",
		status: "",
	}
	return `Usage: comb migrate ${mode} <database> [-e <env>] [--dir <path>]${flags[mode]}`
}

/**
 * `migrate apply|baseline|check|status`. With --json the human lines go to stderr and stdout is
 * one JSON object: the database, the files applied (or found applied) and pending, and what was
 * refused; a refusal still exits 1.
 */
export async function migrateApply(mode: Mode, argv: readonly string[], io: CliIo): Promise<void> {
	const args = parseArgs(argv, `migrate ${mode}`)
	const [db] = args.positionals
	if (db === undefined || args.positionals.length > 1) throw new CliError(usage(mode))
	if (args.options["json"] !== true) {
		await runMode({ args, db, io, mode })
		return
	}
	const report = (outcome: MigrateOutcome, refused: string[]) =>
		io.out(JSON.stringify({ applied: outcome.applied, database: db, pending: outcome.pending, refused }))
	try {
		report(await runMode({ args, db, io: { ...io, out: io.err }, mode }), [])
	} catch (error) {
		/* a refusal or a failed command is an Error; a user's config can throw anything */
		report({ applied: [], pending: [] }, [error instanceof Error ? error.message : String(error)])
		throw error
	}
}

/** `request.mode` on the database `request.db` resolves to, on its engine */
async function runMode(request: Request): Promise<MigrateOutcome> {
	const { args, db, io, mode } = request
	const resolved = await resolveMigrateTarget({
		cwd: io.cwd,
		db,
		dir: option(args, "dir"),
		env: option(args, "env"),
		mode: "apply",
	})
	if (resolved?.provider.type === "postgres") {
		const { migratePostgres } = await import("./migrate-atlas.ts")
		return migratePostgres(mode, { ...resolved, provider: resolved.provider }, { args, io })
	}
	if (resolved === undefined || resolved.provider.type === "d1") {
		const { migrateD1 } = await import("./migrate-d1.ts")
		return migrateD1(request, resolved)
	}
	if (mode === "status") {
		throw new CliError(
			`migrate status reads the history Atlas or wrangler records, which Postgres and D1 databases have; ${resolved.label} keeps comb's own`,
		)
	}
	const target = await configuredTarget(request, { ...resolved, provider: resolved.provider })
	try {
		return await migrateSqlite(request, target)
	} finally {
		await target.conn.close()
	}
}
