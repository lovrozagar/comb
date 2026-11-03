/**
 * Each pending D1 file proven on D1's own engine (SD1 and SD2 of r22): after the bun:sqlite proof, the
 * files run in order on a scratch local D1 that the checked wrangler's own Miniflare opens
 * (`getPlatformProxy({ persist: false })`), holding the live schema and the proof's seed rows
 * (proof-copy.ts), each as wrangler sends it: the file and the history row it appends, through
 * wrangler's `splitSqlQuery`, in one batch. D1 resolves a function in a trigger body, a view or a
 * generated column only when a statement uses it, so EXPLAIN then compiles each view, and each
 * table's INSERT, UPDATE and DELETE, the file made or changed. What D1 refuses is refused, naming D1's
 * error, with no override: D1's authorizer, functions, modules and limits are the engine's, with no list
 * of comb's to keep. A file whose text wrangler would rewrite is refused before anything runs.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { importBin } from "./optional-peer.ts"
import type { ProjectBin } from "./process.ts"
import { copyScript, creatable, type LiveObject } from "./proof-copy.ts"
import { quote } from "./proof-seed.ts"

type D1Statement = { all(): Promise<{ results?: Array<Record<string, unknown>> | undefined }> }
type D1Database = { batch(statements: D1Statement[]): Promise<unknown>; prepare(sql: string): D1Statement }
type PlatformProxy = { dispose(): Promise<void>; env: Record<string, unknown> }

/** The surface of wrangler comb calls for the proof */
type Wrangler = {
	getPlatformProxy(options: { configPath: string; persist: false }): Promise<PlatformProxy>
	unstable_splitSqlQuery(sql: string): string[]
}

/** A pending file: its name, and its text as the migrations directory holds it */
type File = { name: string; sql: string }

/* the scratch worker's config: one D1 binding, which Miniflare keeps in memory */
const CONFIG = {
	compatibility_date: "2025-01-01",
	d1_databases: [{ binding: "DB", database_id: "00000000-0000-0000-0000-000000000000", database_name: "proof" }],
	name: "comb-d1-proof",
}

/* what wrangler's trimSqlQuery looks for: a file holding it has its first "BEGIN TRANSACTION;" and "COMMIT;" cut */
const TRIMMED = "BEGIN TRANSACTION"

/* a literal, a quoted name or a comment, as SQLite reads each */
const NOT_CODE = /'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g

/** The literal, quoted name or comment of `sql` that holds `at`, as the file writes it */
function enclosing(sql: string, at: number): string {
	for (const match of sql.matchAll(NOT_CODE))
		if (match.index <= at && at < match.index + match[0].length) return match[0]
	return "its text"
}

/**
 * Refuses a file whose text wrangler rewrites before a local apply runs it (SD2 of r22): its trimSqlQuery
 * deletes the first `BEGIN TRANSACTION;` and `COMMIT;` wherever they are, in a literal or a comment too,
 * or refuses the file, while a remote apply sends the text as written. A real BEGIN or COMMIT is
 * refused before this, so the words are in a literal, a quoted name or a comment
 */
function refuseRewritten({ name, sql }: File): void {
	const at = sql.indexOf(TRIMMED)
	if (at === -1) return
	throw new Error(
		`${name}: ${enclosing(sql, at)} holds "${TRIMMED}", and wrangler rewrites a file that does before a local apply runs it: it deletes the first "BEGIN TRANSACTION;" and the first "COMMIT;" wherever they are, literals and comments too, or refuses the file (its trimSqlQuery), so a local apply would store other data than check proves and a remote apply stores; split the words, as in 'BEGIN ' || 'TRANSACTION'`,
	)
}

/** D1's own words for a failure: the cause wrangler's client wraps, when there is one */
function d1Error(error: unknown): string {
	const { cause, message } = error as Error
	return cause instanceof Error ? cause.message : message
}

/** `statements` in one batch, as wrangler sends a file's */
async function run(db: D1Database, statements: readonly string[]): Promise<void> {
	await db.batch(statements.map((sql) => db.prepare(sql)))
}

/**
 * The scratch D1's schema, each object by type and name: a virtual table's shadow tables left out,
 * which its module alone writes (D1: "may not be modified")
 */
async function master(db: D1Database): Promise<Map<string, LiveObject>> {
	const { results = [] } = await db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")
		.all()
	const objects = results.map((row) => ({
		name: String(row["name"]),
		sql: String(row["sql"]),
		table: String(row["tbl_name"]),
		type: String(row["type"]),
	}))
	return new Map(creatable(objects).map((object) => [`${object.type} ${object.name}`, object]))
}

/** The EXPLAINs that compile what a file made or changed: each view's read, and each table's writes, triggers and generated columns with them */
async function probes(db: D1Database, before: ReadonlyMap<string, LiveObject>): Promise<string[]> {
	const changed = [...(await master(db))].filter(([key, object]) => before.get(key)?.sql !== object.sql)
	const views = changed.filter(([, object]) => object.type === "view").map(([, object]) => object.table)
	const tables = new Set(
		changed
			.filter(([, object]) => object.type === "table" || object.type === "trigger")
			.map(([, object]) => object.table),
	)
	const writes: string[] = []
	for (const table of tables) {
		const { results = [] } = await db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all()
		const columns = results.filter((row) => row["hidden"] === 0).map((row) => quote(String(row["name"])))
		writes.push(
			`EXPLAIN INSERT INTO ${quote(table)} DEFAULT VALUES`,
			`EXPLAIN UPDATE ${quote(table)} SET ${columns.map((column) => `${column} = ${column}`).join(", ")}`,
			`EXPLAIN DELETE FROM ${quote(table)}`,
		)
	}
	return [...views.map((view) => `EXPLAIN SELECT * FROM ${quote(view)}`), ...writes]
}

/** The scratch D1, the checked wrangler, and the binding's history table */
type Scratch = { db: D1Database; table: string; wrangler: Wrangler }

/** Runs `file` on the scratch D1 as wrangler sends it, then its probes; throws what D1 refuses, naming D1's error */
async function proveFile({ db, table, wrangler }: Scratch, file: File): Promise<void> {
	const query = `${file.sql}\nINSERT INTO ${quote(table)} (name)\nvalues ('${file.name.replaceAll("'", "''")}');`
	const before = await master(db)
	try {
		await run(db, wrangler.unstable_splitSqlQuery(query))
	} catch (error) {
		throw new Error(
			`${file.name}: D1 refuses this file on its own engine, as wrangler's apply would: ${d1Error(error)}; leave out what D1 does not run`,
			{ cause: error },
		)
	}
	for (const probe of await probes(db, before)) {
		try {
			await run(db, [probe])
		} catch (error) {
			throw new Error(
				`${file.name}: D1 applies this file, then refuses ${probe.replace(/^EXPLAIN /, "")}: ${d1Error(error)}, so it would fail on the live database once applied; leave out what D1 does not run`,
				{ cause: error },
			)
		}
	}
}

/**
 * Proves `files`, in order, on a scratch D1 of the checked wrangler `bin` holding the copy of the live
 * schema `live`; `table` is the binding's migration history, which each file's appended row goes to
 */
async function proveOnD1(
	live: readonly LiveObject[],
	files: readonly File[],
	{ bin, table }: { bin: ProjectBin; table: string },
): Promise<void> {
	for (const file of files) refuseRewritten(file)
	const wrangler = await importBin<Wrangler>(bin)
	const script = await copyScript(live, files)
	const dir = mkdtempSync(join(tmpdir(), "comb-d1-proof-"))
	try {
		const configPath = join(dir, "wrangler.json")
		writeFileSync(configPath, JSON.stringify(CONFIG))
		const proxy = await wrangler.getPlatformProxy({ configPath, persist: false })
		try {
			const db = proxy.env["DB"] as D1Database
			const history = `CREATE TABLE IF NOT EXISTS ${quote(table)} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
			await run(db, [...script, history])
			for (const file of files) await proveFile({ db, table, wrangler }, file)
		} finally {
			await proxy.dispose()
		}
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

export { enclosing, proveOnD1, refuseRewritten }
