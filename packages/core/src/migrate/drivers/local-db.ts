/**
 * A private SQLite database for comb's own reads and runs, bun:sqlite under Bun and node:sqlite
 * under Node; nothing in it reaches a target database. In memory for a read alone (absent.ts), and
 * a scratch file where migration files run (the proof copy, baseline's replay), so each file runs
 * on a fresh connection, as each one applies, and its connection settings end with it.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import { pathToFileURL } from "node:url"
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

/** The SQLite a scratch runs on: the runtime's own, or libsql's, which a libsql or Turso target applies its files on */
export type ScratchEngine = "libsql" | "runtime"

/** How a database file, or `:memory:`, opens on an engine; with `create` false, only a file that is there, read-write */
export type Open = (file: string, create?: boolean) => LocalDb

/** The engine's opener; under Node, node:sqlite, a built-in from 22.13 on, so an older Node is refused by its floor */
async function opener(engine: ScratchEngine): Promise<Open> {
	if (engine === "libsql") {
		const { libsqlLocal } = await import("./libsql-local.ts")
		return libsqlLocal()
	}
	if (process.versions["bun"] !== undefined) {
		const { bunLocal } = await import("./bun-sqlite.ts")
		return bunLocal()
	}
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number)
	if (major < 22 || (major === 22 && minor < 13))
		throw new Error(`comb needs Node 22.13 or later (node:sqlite); this is ${process.versions.node}`)
	const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
		DatabaseSync: new (file: string) => { close(): void; exec(sql: string): void; prepare(sql: string): NodeStatement }
	}
	return (file, create) => {
		/* SQLite's URI form is how node:sqlite opens without creating: mode=rw */
		const db = new DatabaseSync(create === false ? `${pathToFileURL(file).href}?mode=rw` : file)
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

/** SQLite's result code for a lock another connection holds */
const SQLITE_BUSY = 5

/**
 * Whether another connection holds the write lock of the database file `file` now, as SQLite answers a try at it:
 * BEGIN IMMEDIATE with no busy wait, rolled back at once, so nothing is written, on the file opened read-write and
 * never created. The answer is SQLite's code, node:sqlite's errcode or bun:sqlite's errno, never its text; a file
 * that is not there, or that SQLite cannot open, holds no lock comb can see.
 */
export async function writeLocked(file: string): Promise<boolean> {
	const open = await opener("runtime")
	let db: LocalDb | undefined
	try {
		db = open(file, false)
		db.exec("PRAGMA busy_timeout = 0")
		db.exec("BEGIN IMMEDIATE")
		db.exec("ROLLBACK")
		return false
	} catch (error) {
		// reason: the probe's own failure is its answer: SQLite's busy code is the lock, and any other (no file, no database) holds none
		const { errcode, errno } = error as { errcode?: unknown; errno?: unknown }
		return [errcode, errno].includes(SQLITE_BUSY)
	} finally {
		db?.close()
	}
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
 * kept a descriptor, and 300 pending files ran a process out;
 * in memory a held connection takes none.
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
 * leaves it only until the next process's first scratch, which sweeps it.
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
		/* comb's reads key rows by SQLite's default column names, which a file's PRAGMA full_column_names = 1
		   renames (sqlite_master.name); the pragmas name a read's columns, never a view's or a table's */
		exec: (sql) => {
			db.exec(sql)
			db.exec("PRAGMA full_column_names = 0; PRAGMA short_column_names = 1")
		},
		firstStatement: (sql) => db.firstStatement(sql),
		reopen: () => {
			db.close()
			db = connect()
		},
		run: (sql, params) => db.run(sql, params),
	}
}
