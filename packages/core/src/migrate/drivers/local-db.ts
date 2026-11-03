/**
 * A private SQLite database for comb's own reads and runs, bun:sqlite under Bun and node:sqlite
 * under Node; nothing in it reaches a target database. In memory for a read alone (absent.ts), and
 * a scratch file where migration files run (the proof copy, baseline's replay), so each file runs
 * on a fresh connection, as each one applies, and its connection settings end with it (S1 of r21).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** What comb does with a private database */
export type LocalDb = {
	/** each row a statement returns, by column */
	all(sql: string, params?: readonly unknown[]): Array<Record<string, unknown>>
	close(): void
	/** run statements, several at once */
	exec(sql: string): void
	/** run one statement with parameters */
	run(sql: string, params?: readonly unknown[]): void
}

/** A scratch database: a file only this user can open, removed on close */
export type ScratchDb = LocalDb & {
	/** close this connection and open a fresh one to the same file: what it holds stays, what the connection set does not */
	reopen(): void
}

type NodeStatement = { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }

/** How this runtime opens a database file, or `:memory:` */
type Open = (file: string) => LocalDb

async function opener(): Promise<Open> {
	if (process.versions["bun"] !== undefined) {
		const { bunLocal } = await import("./bun-sqlite.ts")
		return bunLocal()
	}
	const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
		DatabaseSync: new (file: string) => { close(): void; exec(sql: string): void; prepare(sql: string): NodeStatement }
	}
	return (file) => {
		const db = new DatabaseSync(file)
		return {
			all: (sql, params = []) => db.prepare(sql).all(...params) as Array<Record<string, unknown>>,
			close: () => db.close(),
			exec: (sql) => db.exec(sql),
			run: (sql, params = []) => void db.prepare(sql).run(...params),
		}
	}
}

/** A new in-memory database on the runtime comb runs on */
export async function openMemory(): Promise<LocalDb> {
	return (await opener())(":memory:")
}

const SCRATCH = "comb-scratch-"

/** How old a scratch directory is before a later run reads it as one a killed run left: no run holds one this long */
export const SCRATCH_STALE_MS: number = 6 * 60 * 60_000

/** Remove the scratch directories killed runs of this user left in `dir`; one another user owns, or one in use, stays */
export function sweepScratch(dir: string = os.tmpdir(), now: number = Date.now()): void {
	const uid = process.getuid?.()
	for (const name of fs.readdirSync(dir)) {
		if (!name.startsWith(SCRATCH)) continue
		const full = path.join(dir, name)
		try {
			const stat = fs.statSync(full)
			if ((uid === undefined || stat.uid === uid) && now - stat.mtimeMs > SCRATCH_STALE_MS)
				fs.rmSync(full, { force: true, recursive: true })
		} catch {
			// reason: another run removed it first, or it is not ours to remove; either way nothing is left to do
		}
	}
}

// per-process-constant: the sweep runs once a process, at its first scratch
let swept = false

/**
 * A new scratch database: a file in a directory of its own that only this user can open (0700),
 * removed with it on close. The first one a process opens sweeps what killed runs left, so a run
 * killed before its close leaves its directory only until a later run's sweep.
 */
export async function openScratch(): Promise<ScratchDb> {
	const open = await opener()
	if (!swept) {
		swept = true
		sweepScratch()
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH))
	const file = path.join(dir, "copy.db")
	/* the scratch is thrown away, so nothing it writes needs to survive a crash; a rollback still works */
	const connect = () => {
		const db = open(file)
		db.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF")
		return db
	}
	let db = connect()
	return {
		all: (sql, params) => db.all(sql, params),
		close: () => {
			try {
				db.close()
			} finally {
				fs.rmSync(dir, { force: true, recursive: true })
			}
		},
		exec: (sql) => db.exec(sql),
		reopen: () => {
			db.close()
			db = connect()
		},
		run: (sql, params) => db.run(sql, params),
	}
}
