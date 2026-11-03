/**
 * The connection one migration file applies on in a local libsql file (SL1 of r22): libsql's own
 * synchronous Database, the engine @libsql/client runs a file through, driven by `exec` alone.
 * @libsql/client's close leaves the file open while a statement it prepared lives, so a run of files
 * on a connection each ran out of descriptors (c3bb8ee, .tmp/grunt/p21/areas/sqlite/5.6-probe-db.log);
 * `exec` keeps no statement past its call, and `close` lets go of the file.
 */
import { createRequire } from "node:module"
import { BUSY_TIMEOUT, type FileConnection } from "../core/apply.ts"
import { optionalPeer } from "../core/optional-peer.ts"
import { LIBSQL } from "../core/peer-needs.ts"
import { LIBSQL_CLIENT } from "./libsql-client.ts"

/** The surface of libsql's Database comb calls: `prepare` only on a scratch (libsql-local.ts), never on a target */
type Database = {
	close(): void
	exec(sql: string): void
	readonly inTransaction: boolean
	prepare(sql: string): {
		all(...params: unknown[]): unknown[]
		get(...params: unknown[]): unknown
		run(...params: unknown[]): unknown
	}
}
type DatabaseClass = new (path: string) => Database

/** libsql's Database, from the copy the @libsql/client comb resolves loads, so the two never differ */
const libsqlDatabase = (): Promise<DatabaseClass> =>
	optionalPeer(LIBSQL, () =>
		Promise.resolve(createRequire(import.meta.resolve(LIBSQL_CLIENT))("libsql") as DatabaseClass),
	)

/** `value` as a SQL literal: the history row's hash, time and name, which `exec` takes with no parameters */
function literal(value: unknown): string {
	if (value === null) return "NULL"
	if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`
	if (typeof value === "bigint" || (typeof value === "number" && Number.isFinite(value))) return String(value)
	throw new TypeError(`comb binds no ${typeof value} into a migration's statement`)
}

/** `sql` with each `?` its parameter as a literal; a statement with none is sent as written */
function bound(sql: string, params: readonly unknown[] = []): string {
	if (params.length === 0) return sql
	const marks = sql.split("?")
	if (marks.length - 1 !== params.length)
		throw new TypeError(`${params.length} parameters for ${marks.length - 1} placeholders in ${sql}`)
	return marks.reduce((text, part, at) => `${text}${literal(params[at - 1])}${part}`)
}

/** libsql's error as @libsql/client words it, `CODE: message`, so a file's failure reads the same on either; one with no code as it came */
function asClient(error: unknown): unknown {
	const { code, message } = error as Error & { code?: unknown }
	if (typeof code !== "string" || code === "") return error
	return Object.assign(new Error(`${code}: ${message}`, { cause: error }), { code })
}

/** The libsql file at `file`, opened for one migration file: its batch in a transaction of its own, through `exec` */
async function openLibsqlFile(file: string): Promise<FileConnection> {
	const Database = await libsqlDatabase()
	let db: Database
	try {
		db = new Database(file)
		db.exec(BUSY_TIMEOUT)
	} catch (error) {
		throw asClient(error)
	}
	return {
		batch: async (statements) => {
			try {
				/* the write lock taken as the batch begins, so a lock another process holds is waited for (SL4 of r22) */
				db.exec("BEGIN IMMEDIATE")
				for (const { params, sql } of statements) db.exec(bound(sql, params))
				db.exec("COMMIT")
			} catch (error) {
				if (db.inTransaction) db.exec("ROLLBACK")
				throw asClient(error)
			}
		},
		close: async () => {
			db.close()
		},
	}
}

export { libsqlDatabase, openLibsqlFile }
