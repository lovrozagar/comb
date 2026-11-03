/**
 * SL4 of r22: another process holding a local SQLite file's write lock, as the app that serves the
 * file or a second runner does. It runs on the runtime the test runs on, bun:sqlite under Bun and
 * node:sqlite under Node, so vitest and bun test spawn it alike.
 */
import { spawn } from "node:child_process"
import { generateMigrationHash } from "../../src/migrate/core/parse.ts"

const HOLDER = `const Database = typeof Bun === "undefined" ? require("node:sqlite").DatabaseSync : require("bun:sqlite").Database
const db = new Database(process.argv.at(-3))
db.exec("BEGIN IMMEDIATE")
db.exec(process.argv.at(-2))
console.log("locked")
setTimeout(() => { db.exec("COMMIT"); db.close() }, Number(process.argv.at(-1)))`

/** A process holding the write lock on `file` for `ms`, having run `sql` under it; resolves once it holds it, with its exit */
export async function holdLock(file: string, sql: string, ms: number): Promise<{ done: Promise<number | null> }> {
	const holder = spawn(process.execPath, ["-e", HOLDER, file, sql, String(ms)], {
		stdio: ["ignore", "pipe", "inherit"],
	})
	const done = new Promise<number | null>((resolve) => holder.once("exit", resolve))
	await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()))
	return { done }
}

/** 0001: the table, applied before the lock is taken */
export const TABLE = { "0001_t.sql": "CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER);\n" }

/** 0002: the file applied while another process holds the lock */
export const ADD = { "0002_add.sql": "ALTER TABLE t ADD COLUMN w INTEGER;\n" }

/** What the holder writes under its lock: an app's row */
export const APP_WRITE = "INSERT INTO t (v) VALUES (99)"

/** What the holder writes under its lock: 0002 applied and recorded, as a second runner's apply does */
export function otherRun(): string {
	const sql = ADD["0002_add.sql"]
	return `${sql}INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('${generateMigrationHash(sql)}', 1, '0002_add.sql')`
}
