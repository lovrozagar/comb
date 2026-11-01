/**
 * D1 migrations through wrangler. `wrangler d1 migrations apply` runs each file with its row in
 * the binding's `migrations_table` (`d1_migrations` by default) as one batch, so that table is the
 * history and wrangler the applier. comb resolves the binding from the wrangler config the way
 * wrangler does, reads the table, checks the pending files (plan-apply.ts) in wrangler's order,
 * hands them to wrangler with stdin closed, and fails unless the table then holds exactly the
 * files it checked. wrangler takes no backup; bookmark a production database before an apply.
 * That table records names only, so comb records each applied file's hash in its own table, and
 * refuses a file applied, then edited, as it does on its other engines.
 */
import type { ParsedMigration } from "../types.ts"
import type { Approval } from "./approval.ts"
import { absentDatabase } from "../drivers/absent.ts"
import { executeAll } from "../drivers/d1.ts"
import { assertLocalExists, type D1Target, localMissing, type ReadConfig, resolveBinding } from "./d1-binding.ts"
import { d1Files, refuseSwallowing } from "./d1-files.ts"
import { D1_HASH_TABLE, DRIZZLE_HISTORY_TABLE } from "./d1-history-tables.ts"
import {
	hashStatements,
	historyTable,
	literal,
	namesOf,
	quoteName,
	readHistory,
	recordHashes,
	type Rows,
} from "./d1-history-rows.ts"
import { orphanMessage } from "./history-match.ts"
import { generateMigrationHash, legacyMigrationHash, migrationHashes } from "./parse.ts"
import { planApply } from "./plan-apply.ts"
import { Refused } from "./refused.ts"

/**
 * Whether `hash`, recorded for a file of text `sql`, is that text: its current hash, or its
 * pre-0.5.0 one where comb's pre-0.8 history (`drizzle`) still holds it, proof the record is from
 * before 0.5.0, as a 0.13 baseline copied it (M44)
 */
const vouched = (sql: string, hash: string, drizzle: ReadonlySet<string> | undefined): boolean =>
	hash === generateMigrationHash(sql) || (hash === legacyMigrationHash(sql) && drizzle?.has(hash) === true)

/** The files `__drizzle_migrations` records that the migrations table does not */
function recordedByDrizzle(
	files: ReturnType<typeof d1Files>,
	hashes: ReadonlySet<string>,
	applied: ReadonlySet<string>,
): string[] {
	return files
		.filter(({ name, sql }) => !applied.has(name) && migrationHashes(sql).some((hash) => hashes.has(hash)))
		.map(({ name }) => name)
}

/**
 * The history: the migrations table's names, refused while `__drizzle_migrations` records a file
 * it does not, or while it records a name no file has (an applied file renamed or deleted since),
 * which only status lets by, to name. A local database wrangler keeps nowhere yet is refused
 * unless the command `writes`, which reads it as empty
 */
async function history(
	read: ReadConfig,
	target: D1Target,
	{ status = false, writes }: { status?: boolean; writes: boolean },
): Promise<{ applied: Set<string>; orphans: string; table: string; unhashed: string[] }> {
	const table = resolveBinding(read, target)
	if (!writes) assertLocalExists(read, target)
	const { applied, drizzle: hashes, recorded } = readHistory(read, target, table)
	const files = d1Files(target.migrationsDir)
	const copied = hashes === undefined ? [] : recordedByDrizzle(files, hashes, applied)
	if (copied.length > 0) {
		throw new Error(
			`${target.name} records ${copied.join(", ")} in ${DRIZZLE_HISTORY_TABLE}, comb's history before 0.8, but not in ${table}, wrangler's; run comb migrate baseline once to copy the record`,
		)
	}
	const edited = files.find(
		({ name, sql }) => applied.has(name) && recorded.has(name) && !vouched(sql, recorded.get(name) as string, hashes),
	)
	if (edited !== undefined) {
		throw new Error(
			`${edited.name} was applied, then edited: its hash is not the one comb recorded; restore the file, or put the change in a new one`,
		)
	}
	const unhashed = files.filter(({ name }) => applied.has(name) && !recorded.has(name)).map(({ name }) => name)
	const named = new Set(files.map(({ name }) => name))
	const gone = [...applied].filter((name) => !named.has(name))
	const orphans =
		gone.length === 0
			? ""
			: orphanMessage(
					gone.map((name) => ({ hash: "", name })),
					target.migrationsDir,
				)
	if (orphans !== "" && !status) throw new Error(orphans)
	return { applied, orphans, table, unhashed }
}

/** wrangler's own error lines from a failed run, its colours and banner left out; its whole output when it printed none */
function wranglerError({ stderr, stdout }: { stderr: string; stdout: string }): string {
	/* the escape sequences that colour a terminal's text */
	const output = `${stderr}${stdout}`.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")
	const errors = output.split("\n").filter((line) => line.includes("[ERROR]"))
	return (errors.length > 0 ? errors.map((line) => line.trim()).join("; ") : output).trim()
}

/**
 * What wrangler recorded once its apply of `names` ran, read back from the table, never from its output; a run
 * that failed may have made no table. Once wrangler has run, a read that fails is a Refused that says so: which of
 * `names` committed is then unknown, and status reads it
 */
function appliedAfter(
	target: D1Target,
	read: ReadConfig,
	{ names, ok, table }: { names: string[]; ok: boolean; table: string },
): Set<string> {
	try {
		return ok
			? new Set((executeAll(target.exec, target, [namesOf(table)])[0] as Rows).map((row) => String(row["name"])))
			: readHistory(read, target, table).applied
	} catch (error) {
		throw new Refused(
			`wrangler d1 migrations apply ${ok ? "ran" : "failed"}, then reading back what it recorded in ${table} failed: ${(error as Error).message}; comb migrate status says which of the files it applied`,
			names,
		)
	}
}

type D1Apply = {
	approve(migration: ParsedMigration): Promise<Approval>
	/** only check: apply nothing */
	checkOnly?: boolean | undefined
	print(line: string): void
	read: ReadConfig
}

/** Check the pending migrations and, unless only checking, apply them through wrangler; returns them */
async function applyD1(target: D1Target, options: D1Apply): Promise<string[]> {
	const { applied, table } = await history(options.read, target, { writes: options.checkOnly !== true })
	const listed = d1Files(target.migrationsDir)
	refuseSwallowing(listed.filter(({ name }) => !applied.has(name)))
	const files = listed.map(({ name }) => name)
	/* a local database wrangler keeps nowhere yet is checked as the empty one it is, and made by wrangler's apply */
	const conn = localMissing(options.read, target)
		? await absentDatabase(target.name, target.conn.ownedPrefix)
		: target.conn
	const pending = await planApply({
		applied: (name) => applied.has(name),
		approve: options.approve,
		conn,
		d1: true,
		dir: target.migrationsDir,
		exec: target.exec,
		files,
		/* the binding's own history table, and comb's record of hashes */
		historyTables: [table, D1_HASH_TABLE],
		print: options.print,
	})
	const names = pending.map(({ name }) => name)
	if (names.length === 0 || options.checkOnly === true) return names
	/* the hashes go first (S3 of r19): a lost record then fails before wrangler applies anything */
	await recordHashes(
		target.conn,
		pending.map(({ migration, name }) => ({ hash: migration.hash, name })),
	)
	for (const name of names) options.print(`Apply: ${name}`)
	const ran = target.exec("wrangler", ["d1", "migrations", "apply", target.name, ...target.flags], { input: "" })
	const after = appliedAfter(target, options.read, { names, ok: ran.code === 0, table })
	const [applies, rest] = [names.filter((name) => after.has(name)), names.filter((name) => !after.has(name))]
	if (ran.code !== 0) throw new Refused(`wrangler d1 migrations apply failed: ${wranglerError(ran)}`, rest, applies)
	const added = [...after].filter((name) => !applied.has(name))
	if (added.length !== names.length || rest.length > 0) {
		throw new Refused(
			`wrangler recorded ${added.join(", ") || "nothing"} in ${table}, where comb checked ${names.join(", ")}; see the wrangler output above`,
			rest,
			applies,
		)
	}
	return names
}

/**
 * Copy comb's history before 0.8 into wrangler's: each file whose hash `__drizzle_migrations` records
 * gets its hash row and its name in the migrations table, in wrangler's order, wherever it lacks
 * either, so a baseline a lost call left half done, by this version or 0.17.0, is finished by the
 * next. Any other file is left for apply to run. Returns the names marked applied and the names
 * whose hash alone was recorded.
 */
async function baselineD1(
	target: D1Target,
	read: ReadConfig,
	print: (line: string) => void,
): Promise<{ hashed: string[]; marked: string[] }> {
	const table = resolveBinding(read, target)
	const { applied, drizzle: hashes, recorded } = readHistory(read, target, table)
	if (hashes === undefined) {
		throw new Error(
			`${target.name} has no ${DRIZZLE_HISTORY_TABLE} to copy from; baseline records only what a history shows was applied`,
		)
	}
	const files = d1Files(target.migrationsDir)
	/* the files __drizzle_migrations vouches for */
	const drizzled = files.filter(({ sql }) => migrationHashes(sql).some((hash) => hashes.has(hash)))
	const marked = drizzled.filter(({ name }) => !applied.has(name)).map(({ name }) => name)
	const hashed = drizzled.filter(({ name }) => applied.has(name) && !recorded.has(name)).map(({ name }) => name)
	const copied = drizzled.filter(({ name }) => !applied.has(name) || !recorded.has(name))
	if (copied.length > 0) {
		/* the hashes first, then wrangler's rows: whichever --command a split batch loses, a name is
		   never in wrangler's table without its hash, and the rerun copies what is missing. Each copied
		   file is vouched for now, so it is recorded under its current hash, the one D1 compares (M44) */
		await target.conn.batch([
			...hashStatements(copied.map(({ name, sql }) => ({ hash: generateMigrationHash(sql), name }))),
			{ sql: historyTable(table) },
			...marked.map((name) => ({ sql: `INSERT OR IGNORE INTO ${quoteName(table)} (name) VALUES (${literal(name)})` })),
		])
	}
	for (const name of marked) print(`Marked applied: ${name}`)
	for (const name of hashed) print(`Hash recorded: ${name}`)
	for (const { name } of files.filter((file) => !applied.has(file.name) && !marked.includes(file.name))) {
		print(`Not marked: ${name} (${DRIZZLE_HISTORY_TABLE} has no record of it; comb migrate apply runs it)`)
	}
	return { hashed, marked }
}

/**
 * Record the current hash of each applied file comb has none for, as applied before comb recorded
 * hashes (M1), and print each; returns them. The operator vouches that the files are what was
 * applied, having checked them against git; the history's own checks run first, so a pre-0.8
 * record to copy, an applied file edited since, or a name no file has refuses it.
 */
async function adoptHashesD1(target: D1Target, read: ReadConfig, print: (line: string) => void): Promise<string[]> {
	const { unhashed } = await history(read, target, { writes: true })
	const files = d1Files(target.migrationsDir).filter(({ name }) => unhashed.includes(name))
	if (files.length > 0)
		await recordHashes(
			target.conn,
			files.map(({ name, sql }) => ({ hash: generateMigrationHash(sql), name })),
		)
	for (const { name } of files) print(`Hash recorded: ${name}`)
	return unhashed
}

/** Print what wrangler's table records as applied, and what is pending, in wrangler's order; returns both */
async function statusD1(
	target: D1Target,
	read: ReadConfig,
	print: (line: string) => void,
): Promise<{ applied: string[]; pending: string[] }> {
	const { applied: recorded, orphans, unhashed } = await history(read, target, { status: true, writes: false })
	if (orphans !== "") print(orphans)
	const files = d1Files(target.migrationsDir).map(({ name }) => name)
	const applied = files.filter((name) => recorded.has(name))
	const pending = files.filter((name) => !recorded.has(name))
	print(`Applied: ${applied.join(", ") || "none"}`)
	print(`Pending: ${pending.join(", ") || "none"}`)
	if (unhashed.length > 0)
		print(
			`No hash recorded for ${unhashed.join(", ")}, applied before comb recorded them: comb cannot tell whether ${unhashed.length === 1 ? "it was" : "they were"} edited since`,
		)
	return { applied, pending }
}

export { adoptHashesD1, applyD1, baselineD1, statusD1 }
