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
import { Refused } from "../migrate/core/refused.ts"
import { checkPassed, CliError, type CliIo, type MigrateOutcome } from "./output.ts"

type Mode = "apply" | "baseline" | "check" | "status"

/** An open database to migrate: its connection, its migrations, and how to name it */
type Target = { conn: Connection; migrationsDir: string; name: string }

/** One command: what it was asked, and where it reports */
type Request = { args: ParsedArgs; db: string; io: CliIo; mode: Mode }

const option = (args: ParsedArgs, name: string) => args.options[name] as string | undefined

/** The SQLite, libsql or Turso database comb.migrate.config.ts resolved, opened; read-only for check and status */
async function configuredTarget(
	{ args, io, mode }: Request,
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
		readonly: mode === "check" || mode === "status",
	})
	return { conn, migrationsDir: target.migrationsDir, name: target.label }
}

const RECORD = "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)"

/** Apply one checked migration: its statements and its record in one batch */
async function applyPending({ migration }: Pending, target: Target, io: CliIo): Promise<void> {
	io.out(`Apply: ${migration.filename}`)
	const statements = [
		...migration.statements.map((sql) => ({ sql })),
		{ params: [migration.hash, Date.now(), migration.filename], sql: RECORD },
	]
	await withRetry(() => target.conn.batch(statements))
}

/** What `__drizzle_migrations` records: its hashes, and the hash each named file was applied under */
type Recorded = { hashes: Set<string>; names: Map<string, string> }

/** The history `__drizzle_migrations` holds: nothing when it is missing, which only a write would create */
async function recordedHistory(conn: Connection): Promise<Recorded> {
	const table = await conn.execute(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
	)
	if (table.rows.length === 0) return { hashes: new Set(), names: new Map() }
	const { columns, rows } = await conn.execute("SELECT * FROM __drizzle_migrations")
	const [hash, name] = [columns.indexOf("hash"), columns.indexOf("name")]
	const named = rows.filter((row) => name >= 0 && row[name] !== null)
	return {
		hashes: new Set(rows.map((row) => String(row[hash]))),
		names: new Map(named.map((row) => [String(row[name]), String(row[hash])])),
	}
}

/** Name each recorded row a history from before 0.11 left unnamed, by the file whose hash it holds */
async function nameRecorded(conn: Connection, dir: string, { files, recorded }: History): Promise<void> {
	for (const name of files.filter((file) => !recorded.names.has(file))) {
		const hashes = migrationHashes(fs.readFileSync(path.join(dir, name), "utf8"))
		const hash = hashes.find((each) => recorded.hashes.has(each))
		if (hash === undefined) continue
		await conn.execute("UPDATE __drizzle_migrations SET name = ? WHERE hash = ? AND name IS NULL", [name, hash])
		recorded.names.set(name, hash)
	}
}

/** Refuses a file recorded by name under a hash it no longer has: it was applied, then edited */
function refuseEdited(dir: string, { files, recorded }: History): void {
	for (const name of files) {
		const was = recorded.names.get(name)
		if (was === undefined || migrationHashes(fs.readFileSync(path.join(dir, name), "utf8")).includes(was)) continue
		throw new CliError(
			`${name} was applied, then edited: its hash is not the one recorded; restore the file, or put the change in a new one`,
		)
	}
}

/** Whether `name`, a file of `dir`, is recorded under one of its hashes */
const recordedIn = (dir: string, recorded: ReadonlySet<string>) => (name: string) =>
	migrationHashes(fs.readFileSync(path.join(dir, name), "utf8")).some((hash) => recorded.has(hash))

/**
 * Record each file not yet recorded, once the database's schema is the one the files leave: comb
 * compares the two (baseline-compare.ts) and refuses any difference, so nothing is recorded as
 * applied that the database does not reflect
 */
/** The files of a directory, and what the database records */
type History = { files: readonly string[]; recorded: Recorded }

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
		if (hashes.some((hash) => recorded.hashes.has(hash))) continue
		await recordMigrationHash(target.conn, hashes[0] as string, name)
		io.out(`Marked applied: ${name}`)
		marked++
	}
	io.out(`\nBaseline done: ${marked} marked, ${files.length - marked} already tracked`)
}

/**
 * `request.mode` on a SQLite database whose history is comb's own `__drizzle_migrations`; check and
 * status only read it, and create neither it nor the database
 */
async function migrateSqlite({ args, io, mode }: Request, target: Target): Promise<MigrateOutcome> {
	const writes = mode === "apply" || mode === "baseline"
	if (writes) await ensureMigrationsTable(target.conn)
	const recorded = await recordedHistory(target.conn)
	const single = option(args, "file")
	const dir = single === undefined ? target.migrationsDir : path.dirname(path.resolve(io.cwd, single))
	const files = single === undefined ? sqlFiles(dir) : [path.basename(single)]
	if (writes) await nameRecorded(target.conn, dir, { files, recorded })
	refuseEdited(dir, { files, recorded })
	if (mode === "baseline") {
		await baseline(target, { files, recorded }, io)
		return { applied: [], pending: [] }
	}
	const isRecorded = recordedIn(dir, recorded.hashes)
	if (mode === "status") {
		const unapplied = files.filter((name) => !isRecorded(name))
		const applied = files.filter(isRecorded)
		io.out(`Applied: ${applied.join(", ") || "none"}`)
		io.out(`Pending: ${unapplied.join(", ") || "none"}`)
		return { applied, pending: unapplied }
	}
	const yes = args.options["yes"] === true
	const pending = await planApply({
		applied: (_, sql) => migrationHashes(sql).some((hash) => recorded.hashes.has(hash)),
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
		const pending = error instanceof Refused ? error.pending : []
		report({ applied: [], pending }, [error instanceof Error ? error.message : String(error)])
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
	const target = await configuredTarget(request, { ...resolved, provider: resolved.provider })
	try {
		return await migrateSqlite(request, target)
	} finally {
		await target.conn.close()
	}
}
