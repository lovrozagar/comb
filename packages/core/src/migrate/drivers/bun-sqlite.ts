/// <reference types="bun-types" />
/**
 * The bun:sqlite migration driver. Bun's APIs live in this file alone (comb/boundaries), and
 * bun:sqlite is imported on connect, so the module loads under Node too.
 */
import type { BunSqliteProviderConfig, Connection, ConnectionProvider, QueryResult } from "../types.ts"

type SqliteParam = string | number | bigint | boolean | null | Uint8Array

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
		async connect(): Promise<Connection> {
			const { Database } = await import("bun:sqlite")
			return bunSqliteConnection(new Database(config.path) as unknown as BunDatabase)
		},
		dialect: "sqlite",
	}
}
