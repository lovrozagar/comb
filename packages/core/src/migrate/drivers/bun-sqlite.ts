/**
 * The bun:sqlite migration driver. Bun's APIs live in this file alone (comb/boundaries), and
 * bun:sqlite is imported on connect, so the module loads under Node too.
 */
import { existsSync } from "node:fs"
import { BUSY_TIMEOUT } from "../core/apply.ts"
import type { LocalDb } from "./local-db.ts"
import { DatabaseMissing } from "./missing.ts"
import type {
	BunSqliteProviderConfig,
	Connection,
	ConnectionProvider,
	QueryResult,
	ResolvedDatabaseConfig,
} from "../types.ts"

const BUN_SQLITE = "bun:sqlite"

type SqliteParam = string | number | bigint | boolean | null | Uint8Array

/** The part of bun:sqlite's Database a private database uses */
type BunLocal = {
	close(): void
	exec(sql: string): unknown
	prepare(sql: string): {
		all(...params: SqliteParam[]): unknown[]
		finalize(): void
		run(...params: SqliteParam[]): unknown
		/** the statement's SQL as SQLite compiled it, each parameter as bound */
		toString(): string
	}
}

/** The part of bun:sqlite's Database a migration connection uses */
type BunDatabase = {
	close(): void
	prepare(sql: string): { all(...params: SqliteParam[]): unknown[] }
	run(sql: string, params?: SqliteParam[]): unknown
	transaction(run: () => void): { immediate(): void }
}

function bunSqliteConnection(db: BunDatabase): Connection {
	return {
		/* async, so a failing statement rejects the promise instead of throwing past it */
		async batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
			/* one transaction: every statement applies, or none does; it takes the write lock as it begins (SL4 of r22) */
			db.transaction(() => {
				for (const { params, sql } of statements) db.run(sql, (params ?? []) as SqliteParam[])
			}).immediate()
		},

		async close(): Promise<void> {
			db.close()
		},
		dialect: "sqlite",

		async execute(sql: string, params?: unknown[]): Promise<QueryResult> {
			const rows = db.prepare(sql).all(...((params ?? []) as SqliteParam[])) as Array<Record<string, unknown>>
			const columns = Object.keys(rows[0] ?? {})
			return { columns, rows: rows.map((row) => columns.map((col) => row[col])) }
		},
	}
}

export function createBunSqliteProvider(config: BunSqliteProviderConfig): ConnectionProvider {
	return {
		async connect(dbConfig?: ResolvedDatabaseConfig): Promise<Connection> {
			/* an in-memory database holds nothing to protect, and bun opens none read-only */
			const readonly = dbConfig?.readonly === true && config.path !== ":memory:"
			if (readonly && !existsSync(config.path))
				throw new DatabaseMissing(
					`${config.path} does not exist; check and status open a database read-only, and create none`,
				)
			/* a specifier TypeScript does not resolve: a Node consumer compiles this without bun-types */
			const { Database } = (await import(BUN_SQLITE)) as {
				Database: new (path: string, options?: { readonly?: boolean }) => BunDatabase
			}
			const db = readonly ? new Database(config.path, { readonly }) : new Database(config.path)
			/* SQLite opens with foreign keys off; the proof run, libsql and D1 apply with them on */
			db.run("PRAGMA foreign_keys = ON")
			db.run(BUSY_TIMEOUT)
			return bunSqliteConnection(db)
		},
		dialect: "sqlite",
	}
}

/** `use` on `sql` prepared, the statement finalized whatever `use` does */
function once<T>(db: BunLocal, sql: string, use: (stmt: ReturnType<BunLocal["prepare"]>) => T): T {
	const stmt = db.prepare(sql)
	try {
		return use(stmt)
	} finally {
		stmt.finalize()
	}
}

/** How bun:sqlite opens a private database file, or `:memory:` (local-db.ts) */
async function bunLocal(): Promise<(file: string) => LocalDb> {
	const { Database } = (await import(BUN_SQLITE)) as { Database: new (path: string) => BunLocal }
	return (file) => {
		const db = new Database(file)
		return {
			/* each statement finalized at once: one left open (an EXPLAIN DROP TABLE among them) keeps its table locked */
			all: (sql, params = []) =>
				once(db, sql, (stmt) => stmt.all(...(params as SqliteParam[]))) as Array<Record<string, unknown>>,
			close: () => db.close(),
			exec: (sql) => void db.exec(sql),
			firstStatement: (sql) => once(db, sql, (stmt) => stmt.toString()),
			run: (sql, params = []) => void once(db, sql, (stmt) => stmt.run(...(params as SqliteParam[]))),
		}
	}
}

export { bunLocal }
