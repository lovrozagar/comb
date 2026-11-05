/**
 * The D1 proof's child (SD1 of r22): what runs each pending file on a scratch local D1 the checked
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
 * @typedef {{ db: D1Database; shadows: ProofInput["shadows"] }} Scratch
 */

/**
 * `name` as SQLite compares names, ASCII case folded
 * @param {string} name
 */
const fold = (name) => name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase())

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
 * The scratch D1's schema, each object by type and name: a virtual table's shadow tables left out,
 * which its module alone writes (D1: "may not be modified"), named by the `shadows` its module makes.
 * Not pragma_table_list, which opens every table and runs D1 out of memory on a large schema
 * @param {D1Database} db
 * @param {ProofInput["shadows"]} shadows
 * @returns {Promise<Map<string, SchemaObject>>}
 */
async function master(db, shadows) {
	const { results = [] } = await db
		.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL")
		.all()
	const shadow = new Set(
		results.flatMap((row) => {
			const module = /^CREATE\s+VIRTUAL\s+TABLE\b[^]*?\bUSING\s+(\w+)/i.exec(String(row["sql"]))?.[1]
			const suffixes = module === undefined ? [] : (shadows[module.toLowerCase()] ?? [])
			return suffixes.map((suffix) => fold(`${String(row["name"])}_${suffix}`))
		}),
	)
	return new Map(
		results
			.filter((row) => !(row["type"] === "table" && shadow.has(fold(String(row["name"])))))
			.map((row) => [
				`${String(row["type"])} ${String(row["name"])}`,
				{ sql: String(row["sql"]), table: String(row["tbl_name"]), type: String(row["type"]) },
			]),
	)
}

/**
 * The EXPLAINs that compile what a file made or changed: each view's read, and each table's writes,
 * triggers and generated columns with them
 * @param {D1Database} db
 * @param {ProofInput["shadows"]} shadows
 * @param {ReadonlyMap<string, SchemaObject>} before
 * @returns {Promise<string[]>}
 */
async function probes(db, shadows, before) {
	const changed = [...(await master(db, shadows))].filter(([key, object]) => before.get(key)?.sql !== object.sql)
	const views = changed.filter(([, object]) => object.type === "view").map(([, object]) => object.table)
	const tables = new Set(
		changed
			.filter(([, object]) => object.type === "table" || object.type === "trigger")
			.map(([, object]) => object.table),
	)
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
 * Runs `file` on the scratch D1 as wrangler sends it, then its probes; what D1 refuses, naming D1's
 * error, or undefined
 * @param {Scratch} scratch
 * @param {Wrangler} wrangler
 * @param {{ name: string; query: string }} file
 * @returns {Promise<string | undefined>}
 */
async function proveFile({ db, shadows }, wrangler, file) {
	const before = await master(db, shadows)
	try {
		await run(db, wrangler.unstable_splitSqlQuery(file.query))
	} catch (error) {
		return `${file.name}: D1 refuses this file on its own engine, as wrangler's apply would: ${d1Error(error)}; leave out what D1 does not run`
	}
	for (const probe of await probes(db, shadows, before)) {
		try {
			await run(db, [probe])
		} catch (error) {
			return `${file.name}: D1 applies this file, then refuses ${probe.replace(/^EXPLAIN /, "")}: ${d1Error(error)}, so it would fail on the live database once applied; leave out what D1 does not run`
		}
	}
	return undefined
}

/**
 * Proves `files`, in order, on a scratch D1 of the wrangler at `wrangler` seeded by `seed`: the
 * first refusal, or none
 * @param {ProofInput} input
 * @returns {Promise<ProofResult>}
 */
export async function prove({ configPath, files, seed, shadows, wrangler: entry }) {
	const wrangler = /** @type {Wrangler} */ (await import(pathToFileURL(entry).href))
	const proxy = await wrangler.getPlatformProxy({ configPath, persist: false })
	try {
		const db = /** @type {D1Database} */ (proxy.env["DB"])
		await run(db, seed)
		for (const file of files) {
			const refused = await proveFile({ db, shadows }, wrangler, file)
			if (refused !== undefined) return { refused }
		}
		return {}
	} finally {
		await proxy.dispose()
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
