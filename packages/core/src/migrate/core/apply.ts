/**
 * comb's own migration record on SQLite: the `__drizzle_migrations` table, the hashes in it and,
 * from 0.11, each file's name beside its hash, so an applied file edited since is told from a new one;
 * from 0.13 the name, not the hash, is unique, so two files of one text are recorded apart
 */
import { chainText } from "../../error-chain.ts"
import type { Connection } from "../types.ts"
import { Refused } from "./refused.ts"
import { isTransient } from "./transient.ts"
import { type RetryOptions, withRetry } from "./utils.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATIONS TABLE
   ═══════════════════════════════════════════════════════════════════════════ */

/* comb's history from 0.13: a name is recorded once, a hash as often as files hold that text (M16) */
const TABLE = `(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      name TEXT UNIQUE
    )`

/** Whether a unique index of comb's history holds its hash alone, as comb's table did before 0.13 */
export async function hashUnique(conn: Connection): Promise<boolean> {
	const list = await conn.execute("PRAGMA index_list(__drizzle_migrations)")
	const unique = list.rows.filter((row) => Number(row[list.columns.indexOf("unique")]) === 1)
	for (const index of unique) {
		const name = String(index[list.columns.indexOf("name")])
		const info = await conn.execute(`PRAGMA index_info("${name.replaceAll('"', '""')}")`)
		const columns = info.rows.map((row) => String(row[info.columns.indexOf("name")]))
		if (columns.length === 1 && columns[0] === "hash") return true
	}
	return false
}

/**
 * comb's history, made where it is missing, named from 0.11, and from a history before 0.13
 * rebuilt in one batch: every row and id kept, each row `renamed` lists taking its new name (M35),
 * and the AUTOINCREMENT counter kept above every id it handed out (M36)
 */
export async function ensureMigrationsTable(
	conn: Connection,
	renamed: ReadonlyArray<{ id: number; name: string }> = [],
): Promise<void> {
	await conn.execute(`CREATE TABLE IF NOT EXISTS __drizzle_migrations ${TABLE}`)
	/* a history from before 0.11 gains the column; drizzle's own migrator ignores it */
	/* PRAGMA table_info answers in rows, since a driver may name no columns for an empty result */
	const { columns, rows } = await conn.execute("PRAGMA table_info(__drizzle_migrations)")
	const named = rows.some((row) => row[columns.indexOf("name")] === "name")
	if (!named) await conn.execute("ALTER TABLE __drizzle_migrations ADD COLUMN name TEXT")
	/* a history from before 0.13 holds each hash once: rebuilt, in one batch, with every row and id kept */
	if (!(await hashUnique(conn))) return
	/* a history made without AUTOINCREMENT has no counter; its largest id is where the new one starts */
	const sequenced = await conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'")
	const counted =
		sequenced.rows.length === 0
			? "0"
			: "coalesce((SELECT seq FROM sqlite_sequence WHERE name = '__drizzle_migrations'), 0)"
	const counter = await conn.execute(`SELECT max(${counted}, coalesce((SELECT max(id) FROM __drizzle_migrations), 0))`)
	const seq = Number(counter.rows[0]?.[0])
	/* a view or trigger over the history would fail the rename, and the drop takes an index on it: each goes before the rebuild and comes back after (M42) */
	const over = await conn.execute(
		"SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'view', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND instr(lower(sql), '__drizzle_migrations') > 0 ORDER BY rowid",
	)
	const dependents = over.rows.map((row) => ({ name: String(row[1]), sql: String(row[2]), type: String(row[0]) }))
	const statements = [
		...dependents.map(({ name, type }) => ({ sql: `DROP ${type.toUpperCase()} "${name.replaceAll('"', '""')}"` })),
		{ sql: `CREATE TABLE __drizzle_migrations_next ${TABLE}` },
		{
			sql: "INSERT INTO __drizzle_migrations_next (id, hash, created_at, name) SELECT id, hash, created_at, name FROM __drizzle_migrations",
		},
		...renamed.map(({ id, name }) => ({
			params: [name, id],
			sql: "UPDATE __drizzle_migrations_next SET name = ? WHERE id = ?",
		})),
		{ sql: "DROP TABLE __drizzle_migrations" },
		{ sql: "ALTER TABLE __drizzle_migrations_next RENAME TO __drizzle_migrations" },
		{ sql: "DELETE FROM sqlite_sequence WHERE name = '__drizzle_migrations'" },
		{ params: [seq], sql: "INSERT INTO sqlite_sequence (name, seq) VALUES ('__drizzle_migrations', ?)" },
		...dependents.map(({ sql }) => ({ sql })),
		/* SQLite resolves a view's columns only when it is read: each is read once, so one that no longer resolves rolls back */
		...dependents
			.filter(({ type }) => type === "view")
			.map(({ name }) => ({ sql: `SELECT * FROM "${name.replaceAll('"', '""')}" LIMIT 0` })),
	]
	try {
		await conn.batch(statements)
	} catch (error) {
		if (dependents.length === 0) throw error
		const objects = dependents.map(({ name, type }) => `${type} ${name}`).join(", ")
		throw new Error(
			`comb could not rebuild __drizzle_migrations for 0.13 with the ${objects} over it, and changed nothing: ${(error as Error).message}`,
			{ cause: error },
		)
	}
}

/**
 * Whether a migration is recorded under any of `hashes`; pass `migrationHashes(sql)` so a file
 * recorded under the pre-0.5.0 hash still counts as applied.
 */
export async function checkMigrationHash(conn: Connection, hashes: string | readonly string[]): Promise<boolean> {
	const list = typeof hashes === "string" ? [hashes] : [...hashes]
	const marks = list.map(() => "?").join(", ")
	const result = await conn.execute(`SELECT hash FROM __drizzle_migrations WHERE hash IN (${marks})`, list)
	return result.rows.length > 0
}

const RECORD = "INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?)"

/** Record `hash` as applied, under the file's `name` when given (an unnamed row is named on the next apply) */
export async function recordMigrationHash(conn: Connection, hash: string, name?: string): Promise<void> {
	await conn.execute(RECORD, [hash, Date.now(), name ?? null])
}

/** A file to apply: its statements, and the hash and name its record holds */
type Recorded = { filename: string; hash: string; statements: readonly string[] }

/**
 * The connection one file applies on: its batch, then its close. It reads nothing, so a libsql file's
 * can run on `exec` alone (SL1 of r22); a read of comb's history goes through the command's own connection
 */
export type FileConnection = Pick<Connection, "batch" | "close">

/** How a file's batch is retried: the connection that reads comb's history after a lost answer, and the backoff */
type ApplyOptions = { history: Pick<Connection, "execute">; retry?: RetryOptions | undefined }

/** Whether comb's history records the file `name` */
const recorded = async (conn: Pick<Connection, "execute">, name: string): Promise<boolean> =>
	(await conn.execute("SELECT 1 FROM __drizzle_migrations WHERE name = ?", [name])).rows.length > 0

/** A batch that failed transiently with no read of the history answering after it: whether it committed is unknown */
class Unconfirmed extends Error {}

/**
 * `migration`'s statements and its record in one batch, retried while it fails transiently. A
 * batch can commit and its answer still fail, and its statements need not run twice safely: the
 * record it wrote says it ran, so a retry reads the history first and runs nothing again (S6).
 * When no read of `history` answers after a batch that failed transiently, the failure is an Unconfirmed (S3 of r20)
 */
export async function applyRecorded(
	conn: Pick<Connection, "batch">,
	migration: Recorded,
	{ history, retry }: ApplyOptions,
): Promise<void> {
	const statements = [
		...migration.statements.map((sql) => ({ sql })),
		{ params: [migration.hash, Date.now(), migration.filename], sql: RECORD },
	]
	let tried = false
	let lost: unknown
	try {
		await withRetry(async () => {
			if (tried) {
				if (await recorded(history, migration.filename)) return
				lost = undefined
			}
			tried = true
			await conn.batch(statements).catch((error: unknown) => {
				if (isTransient(error)) lost = error
				throw error
			})
		}, retry)
	} catch (error) {
		if (lost === undefined) throw error
		throw new Unconfirmed(
			`${migration.filename} may have committed: its batch failed with ${chainText(lost)}, and no read of comb's history answered after it; comb migrate status says whether it applied`,
			{ cause: error },
		)
	}
}

/**
 * Each of `migrations` applied and recorded in turn, its name printed first, each on a connection
 * `open` makes for it alone and closed after it, so what one file sets on its connection ends with
 * that file, as wrangler runs each file on D1 (S1 of r21). A failure stops the run as a Refused
 * naming the files that committed before it and the ones still pending, which it prints as D1's
 * apply does (S2 of the 0.15.0 review); a file whose answer was lost is in neither, but unknown
 */
export async function applyEach(
	open: () => Promise<FileConnection>,
	migrations: readonly Recorded[],
	{ history, print, retry }: ApplyOptions & { print: (line: string) => void },
): Promise<void> {
	const names = migrations.map(({ filename }) => filename)
	for (const [at, migration] of migrations.entries()) {
		print(`Apply: ${migration.filename}`)
		try {
			const conn = await open()
			try {
				await applyRecorded(conn, migration, { history, retry })
			} finally {
				await conn.close()
			}
		} catch (error) {
			const done = names.slice(0, at)
			if (done.length > 0) print(`Applied before the failure: ${done.join(", ")}`)
			/* withRetry throws an Error, whatever the batch threw; so does a connection that would not open */
			const message = (error as Error).message
			if (error instanceof Unconfirmed)
				throw new Refused(message, { applied: done, pending: names.slice(at + 1), unknown: [migration.filename] })
			throw new Refused(message, { applied: done, pending: names.slice(at) })
		}
	}
}
