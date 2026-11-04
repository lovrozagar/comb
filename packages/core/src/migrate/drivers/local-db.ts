/**
 * A private SQLite database for comb's own reads and runs, bun:sqlite under Bun and node:sqlite
 * under Node; nothing in it reaches a target database. In memory for a read alone (absent.ts), and
 * a scratch file where migration files run (the proof copy, baseline's replay), so each file runs
 * on a fresh connection, as each one applies, and its connection settings end with it (S1 of r21).
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import { pastStop, scratchDir } from "../core/cleanup.ts"

/** What comb does with a private database */
export type LocalDb = {
	/** each row a statement that reads returns, by column: a SELECT, a PRAGMA's read or an EXPLAIN, never a write */
	all(sql: string, params?: readonly unknown[]): Array<Record<string, unknown>>
	close(): void
	/** run statements, several at once */
	exec(sql: string): void
	/** the first statement SQLite reads in `sql`, as it compiled it: its text up to the ; that ends it, if one does */
	firstStatement(sql: string): string
	/** run one statement with parameters */
	run(sql: string, params?: readonly unknown[]): void
}

/** A scratch database: a file only this user can open, removed on close */
export type ScratchDb = LocalDb & {
	/** the SQLite it runs on, as a proof names it: `libsql's SQLite 3.45.1`, `SQLite 3.53.4` */
	engine: string
	/** close this connection and open a fresh one to the same file: what it holds stays, what the connection set does not */
	reopen(): void
}

type NodeStatement = { all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown; sourceSQL: string }

/** The SQLite a scratch runs on: the runtime's own, or libsql's, which a libsql or Turso target applies its files on (SL3 of r22) */
export type ScratchEngine = "libsql" | "runtime"

/** How a database file, or `:memory:`, opens on an engine */
type Open = (file: string) => LocalDb

async function opener(engine: ScratchEngine): Promise<Open> {
	if (engine === "libsql") {
		const { libsqlLocal } = await import("./libsql-local.ts")
		return libsqlLocal()
	}
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
			firstStatement: (sql) => db.prepare(sql).sourceSQL,
			run: (sql, params = []) => void db.prepare(sql).run(...params),
		}
	}
}

/** A new in-memory database on the runtime comb runs on */
export async function openMemory(): Promise<LocalDb> {
	await pastStop()
	return (await opener("runtime"))(":memory:")
}

const SCRATCH = "comb-scratch-"

/** Where a scratch's database lives, as its connections open it, and how it goes once they are done */
type Place = { name: string; release(): void }

/** A file in a scratch directory of its own (cleanup.ts), removed with it */
function filePlace(): Place {
	const { dir, remove } = scratchDir(SCRATCH)
	return { name: path.join(dir, "copy.db"), release: remove }
}

/**
 * A database in memory that every connection of this process opening its name shares (SQLite's memdb
 * VFS), held by a connection of its own until release. libsql keeps a connection a statement was
 * prepared on open until that statement is collected, so on a file each connection a proof reopens
 * kept a descriptor, and 300 pending files ran a process out (SL3 of r22,
 * .tmp/grunt/p21/areas/sqlite/5.7-fd-red.log); in memory a held connection takes none.
 */
function memoryPlace(open: Open): Place {
	const name = `file:/${SCRATCH}${randomUUID()}?vfs=memdb`
	const anchor = open(name)
	return { name, release: () => anchor.close() }
}

/**
 * A new scratch database on `engine`, that only this process can reach: on the runtime's, a file in a
 * directory of its own that only this user can open (0700), removed with it on close; on libsql's, a
 * database in memory. SIGINT and SIGTERM remove the directory too, and a process killed past both
 * leaves it only until the next process's first scratch, which sweeps it (S2 of r22).
 */
export async function openScratch(engine: ScratchEngine = "runtime"): Promise<ScratchDb> {
	/* a scratch made past a stop would outlive the cleanup that removes its directory */
	await pastStop()
	const open = await opener(engine)
	const place = engine === "libsql" ? memoryPlace(open) : filePlace()
	/* the scratch is thrown away, so nothing it writes needs to survive a crash; a rollback still works */
	const connect = () => {
		const db = open(place.name)
		db.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF")
		return db
	}
	let db = connect()
	const version = String(db.all("SELECT sqlite_version() AS v")[0]?.["v"])
	return {
		all: (sql, params) => db.all(sql, params),
		close: () => {
			try {
				db.close()
			} finally {
				place.release()
			}
		},
		engine: engine === "libsql" ? `libsql's SQLite ${version}` : `SQLite ${version}`,
		exec: (sql) => db.exec(sql),
		firstStatement: (sql) => db.firstStatement(sql),
		reopen: () => {
			db.close()
			db = connect()
		},
		run: (sql, params) => db.run(sql, params),
	}
}
