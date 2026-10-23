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
import { ensureMigrationsTable, hashUnique, recordMigrationHash } from "../migrate/core/apply.ts"
import { approveMigration } from "../migrate/core/approval.ts"
import { sqlFiles } from "../migrate/core/atlas-dir.ts"
import { sqliteDrift } from "../migrate/core/baseline-compare.ts"
import {
	type FileHashes,
	type HistoryRow,
	type LegacyRow,
	type Matched,
	matchHistory,
	orphanMessage,
	resolveLegacy,
} from "../migrate/core/history-match.ts"
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

/** The history `__drizzle_migrations` holds, row by row: nothing when it is missing, which only a write would create */
async function recordedHistory(conn: Connection): Promise<LegacyRow[]> {
	const table = await conn.execute(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
	)
	if (table.rows.length === 0) return []
	const { columns, rows } = await conn.execute("SELECT * FROM __drizzle_migrations ORDER BY id")
	const [hash, name, id] = [columns.indexOf("hash"), columns.indexOf("name"), columns.indexOf("id")]
	return rows.map((row) => ({
		hash: String(row[hash]),
		id: Number(row[id]),
		name: name >= 0 && row[name] !== null ? String(row[name]) : null,
	}))
}

/**
 * The history, with a history from before 0.13 read as 0.13 names it (history-match.ts
 * resolveLegacy), and those names, which apply's rebuild then records
 */
async function readHistory(
	conn: Connection,
	dir: string,
): Promise<{ renamed: Array<{ id: number; name: string }>; rows: HistoryRow[] }> {
	const rows = await recordedHistory(conn)
	if (rows.length === 0 || !(await hashUnique(conn))) return { renamed: [], rows }
	const renamed = resolveLegacy(hashed(dir, sqlFiles(dir)), rows)
	const names = new Map(renamed.map(({ id, name }) => [id, name]))
	return { renamed, rows: rows.map((row) => ({ ...row, name: names.get(row.id) ?? row.name })) }
}

/** Each of `files`, a file of `dir`, with the hashes its text has */
const hashed = (dir: string, files: readonly string[]): FileHashes[] =>
	files.map((name) => ({ hashes: migrationHashes(fs.readFileSync(path.join(dir, name), "utf8")), name }))

/**
 * Refuses what the history cannot vouch for: a file applied, then edited, in every mode; a row no
 * file matches (edited or renamed after it was applied) in every mode but status, which names it
 */
function refuseUnmatched(matched: Matched, { dir, io, mode }: { dir: string; io: CliIo; mode: Mode }): void {
	const [edited] = matched.edited
	if (edited !== undefined)
		throw new CliError(
			`${edited} was applied, then edited: its hash is not the one recorded; restore the file, or put the change in a new one`,
		)
	if (matched.orphans.length === 0) return
	const message = orphanMessage(matched.orphans, dir)
	if (mode !== "status") throw new CliError(message)
	io.out(message)
}

/** Name each row a history from before 0.11 left unnamed, by the file it matched */
async function nameRecorded(conn: Connection, named: ReadonlyArray<{ hash: string; name: string }>): Promise<void> {
	for (const { hash, name } of named)
		await conn.execute(
			"UPDATE __drizzle_migrations SET name = ? WHERE id = (SELECT id FROM __drizzle_migrations WHERE hash = ? AND name IS NULL ORDER BY id LIMIT 1)",
			[name, hash],
		)
}

/**
 * Record each file not yet recorded, once the database's schema is the one the files leave: comb
 * compares the two (baseline-compare.ts) and refuses any difference, so nothing is recorded as
 * applied that the database does not reflect
 */
async function baseline(
	target: Target,
	{ files, matched }: { files: readonly FileHashes[]; matched: Matched },
	io: CliIo,
) {
	const drift = await sqliteDrift(target.conn, target.migrationsDir, io.run ?? runProcess)
	if (drift !== "") {
		throw new CliError(
			`${target.name}'s schema is not the one its migrations leave, so baseline records nothing; the difference:\n${drift}`,
		)
	}
	let marked = 0
	for (const { hashes, name } of files) {
		if (matched.applied.has(name)) continue
		await recordMigrationHash(target.conn, hashes[0] as string, name)
		io.out(`Marked applied: ${name}`)
		marked++
	}
	io.out(`\nBaseline done: ${marked} marked, ${files.length - marked} already tracked`)
}

/**
 * A --file's name: its path from the migrations directory, `../lone.sql` outside it; refused in a
 * subdirectory of it, which no whole-directory run reads (M34)
 */
function fileName(single: string, { cwd, dir }: { cwd: string; dir: string }): string {
	const relative = path.relative(dir, path.resolve(cwd, single))
	if (!relative.startsWith("..") && relative.includes(path.sep))
		throw new CliError(
			`${single} is in a subdirectory of ${dir}, which a whole-directory run does not read; move it to the directory's top level, or outside it`,
		)
	return relative
}

/**
 * `request.mode` on a SQLite database whose history is comb's own `__drizzle_migrations`; check and
 * status only read it, and create neither it nor the database. Each recorded row is matched to one
 * file (history-match.ts): a named row by its name, an unnamed one by its hash.
 */
async function migrateSqlite({ args, io, mode }: Request, target: Target): Promise<MigrateOutcome> {
	const writes = mode === "apply" || mode === "baseline"
	const single = option(args, "file")
	const dir = target.migrationsDir
	const relative = single === undefined ? undefined : fileName(single, { cwd: io.cwd, dir })
	const { renamed, rows } = await readHistory(target.conn, dir)
	if (writes) await ensureMigrationsTable(target.conn, renamed)
	const files = hashed(dir, relative === undefined ? sqlFiles(dir) : [relative])
	const matched = matchHistory(files, rows, single === undefined)
	refuseUnmatched(matched, { dir, io, mode })
	if (writes) await nameRecorded(target.conn, matched.named)
	if (mode === "baseline") {
		await baseline(target, { files, matched }, io)
		return { applied: [], pending: [] }
	}
	const names = files.map(({ name }) => name)
	if (mode === "status") {
		const applied = names.filter((name) => matched.applied.has(name))
		const unapplied = names.filter((name) => !matched.applied.has(name))
		io.out(`Applied: ${applied.join(", ") || "none"}`)
		io.out(`Pending: ${unapplied.join(", ") || "none"}`)
		return { applied, pending: unapplied }
	}
	const yes = args.options["yes"] === true
	const pending = await planApply({
		applied: (name) => matched.applied.has(name),
		approve: (migration) => approveMigration(migration, { confirm: io.confirm, target: target.name, yes }),
		conn: target.conn,
		dir,
		exec: io.run ?? runProcess,
		files: names,
		print: io.out,
		whole: single === undefined,
	})
	const pendingNames = pending.map(({ name }) => name)
	if (mode === "check") {
		io.out(checkPassed(pendingNames))
		return { applied: [], pending: pendingNames }
	}
	for (const name of names.filter((file) => !pendingNames.includes(file))) io.out(`Skip (already applied): ${name}`)
	for (const each of pending) await applyPending(each, target, io)
	io.out(`\nDone: ${pendingNames.length} applied, ${names.length - pendingNames.length} skipped`)
	return { applied: pendingNames, pending: [] }
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
