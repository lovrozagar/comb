/**
 * The bun:sqlite migration driver. Bun's APIs live in this file alone (comb/boundaries), and
 * bun:sqlite is imported on connect, so the module loads under Node too.
 */
import { existsSync } from "node:fs"
import type { MemoryDb } from "./memory.ts"
import type {
	BunSqliteProviderConfig,
	Connection,
	ConnectionProvider,
	QueryResult,
	ResolvedDatabaseConfig,
} from "../types.ts"

const BUN_SQLITE = "bun:sqlite"

type SqliteParam = string | number | bigint | boolean | null | Uint8Array

/** The part of bun:sqlite's Database the proof run's in-memory copy uses */
type BunMemory = {
	close(): void
	exec(sql: string): unknown
	prepare(sql: string): { all(...params: SqliteParam[]): unknown[]; run(...params: SqliteParam[]): unknown }
}

/** The part of bun:sqlite's Database a migration connection uses */
type BunDatabase = {
	close(): void
	prepare(sql: string): { all(...params: SqliteParam[]): unknown[] }
	run(sql: string, params?: SqliteParam[]): unknown
	transaction(run: () => void): () => void
}

function bunSqliteConnection(db: BunDatabase): Connection {
	return {
		/* async, so a failing statement rejects the promise instead of throwing past it */
		async batch(statements: Array<{ sql: string; params?: unknown[] }>): Promise<void> {
			/* one transaction: every statement applies, or none does */
			db.transaction(() => {
				for (const { params, sql } of statements) db.run(sql, (params ?? []) as SqliteParam[])
			})()
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
				throw new Error(`${config.path} does not exist; check and status open a database read-only, and create none`)
			/* a specifier TypeScript does not resolve: a Node consumer compiles this without bun-types */
			const { Database } = (await import(BUN_SQLITE)) as {
				Database: new (path: string, options?: { readonly?: boolean }) => BunDatabase
			}
			return bunSqliteConnection(readonly ? new Database(config.path, { readonly }) : new Database(config.path))
		},
		dialect: "sqlite",
	}
}

/** A private in-memory bun:sqlite database, for the proof run (memory.ts) */
async function openBunMemory(): Promise<MemoryDb> {
	const { Database } = (await import(BUN_SQLITE)) as { Database: new (path: string) => BunMemory }
	const db = new Database(":memory:")
	return {
		all: (sql, params = []) => db.prepare(sql).all(...(params as SqliteParam[])) as Array<Record<string, unknown>>,
		close: () => db.close(),
		exec: (sql) => void db.exec(sql),
		run: (sql, params = []) => void db.prepare(sql).run(...(params as SqliteParam[])),
	}
}

export { openBunMemory }
