/**
 * The D1 proof's child: what runs each pending file on a scratch local D1 the checked
 * wrangler's own Miniflare opens (`getPlatformProxy({ persist: false })`). d1-engine.ts starts it on
 * the runtime wrangler runs on (node), through process.ts, whatever runtime comb itself runs on, so
 * Miniflare runs where wrangler's apply runs it. Plain JavaScript: node does not strip a TypeScript
 * file's types under node_modules, where a project holds comb.
 *
 * The seed batch runs first: the copy of the live schema with its seed rows, and the history table.
 * Then each file as wrangler sends it, the file and the history row it appends, through wrangler's
 * `splitSqlQuery`, in one batch. D1 resolves a function in a trigger body, a view or a generated
 * column only when a statement uses it, so EXPLAIN then compiles each view, and each table's INSERT,
 * UPDATE and DELETE, the file made or changed. What D1 refuses comes back in D1's own words.
 */
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/**
 * @typedef {{ all(): Promise<{ results?: Array<Record<string, unknown>> | undefined }> }} D1Statement
 * @typedef {{ batch(statements: D1Statement[]): Promise<unknown>; prepare(sql: string): D1Statement }} D1Database
 * @typedef {{ dispose(): Promise<void>; env: Record<string, unknown> }} PlatformProxy
 * @typedef {{
 *   getPlatformProxy(options: { configPath: string; persist: false }): Promise<PlatformProxy>
 *   unstable_splitSqlQuery(sql: string): string[]
 * }} Wrangler
 * @typedef {{ sql: string; table: string; type: string }} SchemaObject
 * @typedef {import("./d1-engine-child.d.mts").ProofInput} ProofInput
 * @typedef {import("./d1-engine-child.d.mts").ProofResult} ProofResult
 */

/** @param {string} name */
const quote = (name) => `"${name.replaceAll('"', '""')}"`

/**
 * D1's own words for a failure: the cause wrangler's client wraps, when there is one
 * @param {unknown} error
 * @returns {string}
 */
function d1Error(error) {
	const { cause, message } = /** @type {Error} */ (error)
	return cause instanceof Error ? cause.message : message
}

/**
 * `statements` in one batch, as wrangler sends a file's
 * @param {D1Database} db
 * @param {readonly string[]} statements
 */
async function run(db, statements) {
	await db.batch(statements.map((sql) => db.prepare(sql)))
}

/**
 * The scratch D1's schema, each object by type and name
 * @param {D1Database} db
 * @returns {Promise<Map<string, SchemaObject>>}
 */
async function master(db) {
	const { results = [] } = await db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")
		.all()
	return new Map(
		results.map((row) => [
			`${String(row["type"])} ${String(row["name"])}`,
			{ sql: String(row["sql"]), table: String(row["tbl_name"]), type: String(row["type"]) },
		]),
	)
}

/**
 * Whether `table` is a table of rows SQLite itself calls one: not a virtual table, which holds neither triggers nor
 * generated columns and whose module may refuse every write (fts5vocab), nor a shadow table its module alone writes
 * (D1: "may not be modified"). Asked of each changed table alone: pragma_table_list over the whole schema opens every
 * table and runs D1 out of memory on a large one
 * @param {D1Database} db
 * @param {string} table
 */
async function isRowTable(db, table) {
	const { results = [] } = await db.prepare(`PRAGMA table_list(${quote(table)})`).all()
	return results.some((row) => row["schema"] === "main" && row["type"] === "table")
}

/**
 * The EXPLAINs that compile what a file made or changed: each view's read, and each table's writes,
 * triggers and generated columns with them
 * @param {D1Database} db
 * @param {ReadonlyMap<string, SchemaObject>} before
 * @returns {Promise<string[]>}
 */
async function probes(db, before) {
	const changed = [...(await master(db))].filter(([key, object]) => before.get(key)?.sql !== object.sql)
	const views = changed.filter(([, object]) => object.type === "view").map(([, object]) => object.table)
	const tables = new Set(changed.filter(([, object]) => object.type === "trigger").map(([, object]) => object.table))
	for (const [, object] of changed)
		if (object.type === "table" && (await isRowTable(db, object.table))) tables.add(object.table)
	/** @type {string[]} */
	const writes = []
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

/**
 * The scratch D1 a proof runs on: what it holds is replayed on a fresh one when workerd crashes,
 * which a disconnect shows ("other side closed"), not a D1 error
 */
class Scratch {
	/**
	 * @param {Wrangler} wrangler
	 * @param {ProofInput} input
	 * @param {PlatformProxy} proxy
	 */
	constructor(wrangler, input, proxy) {
		this.wrangler = wrangler
		this.configPath = input.configPath
		this.proxy = proxy
		/** @type {string[][]} each batch the scratch D1 has run: the seed, then each file's */
		this.ran = [input.seed]
	}

	get db() {
		return /** @type {D1Database} */ (this.proxy.env["DB"])
	}

	/** A fresh scratch D1 in place of this one, running each batch this one ran */
	async reopen() {
		await this.proxy.dispose()
		this.proxy = await this.wrangler.getPlatformProxy({ configPath: this.configPath, persist: false })
		for (const batch of this.ran) await run(this.db, batch)
	}
}

/**
 * Whether the scratch D1 still answers: a failure it does not survive is workerd crashing
 * @param {D1Database} db
 */
async function answers(db) {
	try {
		await db.prepare("SELECT 1").all()
		return true
	} catch {
		// reason: any failure of SELECT 1 means the scratch D1 is gone, whatever its words
		return false
	}
}

/**
 * D1's error compiling `probe`, or undefined; crashed when workerd crashes on it, and again compiling
 * it alone on a fresh copy, which then replaces it
 * @param {Scratch} scratch
 * @param {string} probe
 * @returns {Promise<{ crashed: true } | { error: string } | undefined>}
 */
async function compile(scratch, probe) {
	for (const fresh of [false, true]) {
		if (fresh) await scratch.reopen()
		try {
			await run(scratch.db, [probe])
			return undefined
		} catch (error) {
			// reason: a D1 that no longer answers crashed, so its error says nothing of the probe; the loop retries it fresh
			if (await answers(scratch.db)) return { error: d1Error(error) }
		}
	}
	await scratch.reopen()
	return { crashed: true }
}

/**
 * Runs `file` on the scratch D1 as wrangler sends it, then its probes: what D1 refuses, naming D1's
 * error, or why the probes prove nothing when workerd crashes on them
 * @param {Scratch} scratch
 * @param {{ name: string; query: string }} file
 * @returns {Promise<{ refused?: string; unproven?: string }>}
 */
async function proveFile(scratch, file) {
	const before = await master(scratch.db)
	/** @type {string[]} */
	let statements
	try {
		/* wrangler's split refuses a file it would rewrite, as its apply does */
		statements = scratch.wrangler.unstable_splitSqlQuery(file.query)
		await run(scratch.db, statements)
	} catch (error) {
		return {
			refused: `${file.name}: D1 refuses this file on its own engine, as wrangler's apply would: ${d1Error(error)}; leave out what D1 does not run`,
		}
	}
	scratch.ran.push(statements)
	/** @type {string[]} */
	const crashed = []
	for (const probe of await probes(scratch.db, before)) {
		const compiled = await compile(scratch, probe)
		const what = probe.replace(/^EXPLAIN /, "")
		if (compiled !== undefined && "error" in compiled)
			return {
				refused: `${file.name}: D1 applies this file, then refuses ${what}: ${compiled.error}, so it would fail on the live database once applied; leave out what D1 does not run`,
			}
		if (compiled !== undefined) crashed.push(what)
	}
	if (crashed.length === 0) return {}
	return {
		unproven: `comb's local D1 (wrangler's workerd) crashed compiling ${crashed.join(", ")} once this file applied, and again on a fresh copy, so D1's engine proves nothing of it; wrangler's apply compiles no such statement, so this does not show the live database refuses the file`,
	}
}

/**
 * Proves `files`, in order, on a scratch D1 of the wrangler at `wrangler` seeded by `seed`: the
 * first refusal, or the files D1's engine could not prove, if any
 * @param {ProofInput} input
 * @returns {Promise<ProofResult>}
 */
export async function prove(input) {
	const wrangler = /** @type {Wrangler} */ (await import(pathToFileURL(input.wrangler).href))
	const scratch = new Scratch(
		wrangler,
		input,
		await wrangler.getPlatformProxy({ configPath: input.configPath, persist: false }),
	)
	try {
		await run(scratch.db, input.seed)
		/** @type {Array<{ name: string; why: string }>} */
		const unproven = []
		for (const file of input.files) {
			const { refused, unproven: why } = await proveFile(scratch, file)
			if (refused !== undefined) return { refused }
			if (why !== undefined) unproven.push({ name: file.name, why })
		}
		return unproven.length === 0 ? {} : { unproven }
	} finally {
		await scratch.proxy.dispose()
	}
}

/**
 * The proof of the input JSON at `input`, as d1-engine.ts writes it
 * @param {string} input
 * @returns {Promise<ProofResult>}
 */
export async function main(input) {
	return await prove(/** @type {ProofInput} */ (JSON.parse(readFileSync(input, "utf8"))))
}
