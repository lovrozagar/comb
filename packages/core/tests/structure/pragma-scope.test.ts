/**
 * S1 of r21: comb opens a fresh connection for each migration file, so a file's connection
 * settings end with it. A pragma whose setting is the process's reaches every connection, other
 * databases' included, so no fresh connection ends it: classify-file.ts refuses each one. This
 * probe asks the running engines which those are: every pragma `pragma_list` names is set on one
 * in-memory database and read on a fresh connection to another, and set back at once.
 */
import { createClient } from "@libsql/client"
import { mkdtempSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PROCESS_PRAGMAS } from "../../src/migrate/core/classify-file.ts"

/** Run `sql` on one connection: its first row's first value, undefined when it returns no row */
type Query = (sql: string) => Promise<unknown>

/** A fresh in-memory connection on an engine comb runs on */
type Engine = { name: string; open(): Query }

const ENGINES: readonly Engine[] = [
	{
		name: "node:sqlite",
		open: () => {
			const db = new DatabaseSync(":memory:")
			/* async, so a statement node:sqlite refuses rejects instead of throwing past the caller */
			return async (sql) => {
				const stmt = db.prepare(sql)
				if (stmt.columns().length === 0) return void stmt.run()
				const row = stmt.get() as Record<string, unknown> | undefined
				return row === undefined ? undefined : Object.values(row)[0]
			}
		},
	},
	{
		name: "libsql",
		open: () => {
			const client = createClient({ url: ":memory:" })
			return async (sql) => (await client.execute(sql)).rows[0]?.[0]
		},
	},
]

/** What `name` reads, or undefined where it reads no row or the read throws */
async function read(query: Query, name: string): Promise<unknown> {
	try {
		return await query(`PRAGMA ${name}`)
	} catch {
		// reason: a pragma that refuses a read here has no value to compare
		return undefined
	}
}

/** The value set away from `was`: a number moved by 50M (no heap limit that low starves the run), else a directory */
const away = (was: unknown, dir: string) =>
	typeof was === "number" || typeof was === "bigint" ? String(Number(was) + 50_000_000) : `'${dir}'`

/** The pragmas `pragma_list` names on `query`'s engine */
async function pragmaNames(query: Query): Promise<string[]> {
	const names: string[] = []
	for (let at = 0; ; at++) {
		const name = await query(`SELECT name FROM pragma_pragma_list LIMIT 1 OFFSET ${at}`)
		if (name === undefined) return names
		names.push(String(name))
	}
}

/** `name` set to `value`, as SQL writes it: no row read reads as the empty setting */
const setTo = (name: string, value: unknown) => `PRAGMA ${name} = ${value === undefined ? "''" : String(value)}`

/**
 * Each pragma `pragma_list` names whose setting on one connection a fresh connection to another
 * database reads. After each, every pragma a fresh connection reads differently is set back, since
 * one process setting moves another (a hard heap limit lowers the soft one).
 */
async function processScoped(engine: Engine, dir: string): Promise<string[]> {
	const names = await pragmaNames(engine.open())
	/* each read first on a connection of its own, as the probe reads it: a read can move another (page_count) */
	const baseline = new Map<string, unknown>()
	for (const name of names) baseline.set(name, await read(engine.open(), name))
	const found: string[] = []
	for (const name of names) {
		const setter = engine.open()
		const was = await read(setter, name)
		if (typeof was === "string") continue
		const moved = await setter(`PRAGMA ${name} = ${away(was, dir)}`).then(
			() => true,
			() => false,
		)
		if (!moved) continue
		const other = engine.open()
		if ((await read(other, name)) !== baseline.get(name)) found.push(name)
		for (const each of names)
			if ((await read(other, each)) !== baseline.get(each)) await setter(setTo(each, baseline.get(each)))
	}
	return found.sort()
}

describe("the pragmas classify-file.ts refuses as the process's are the ones SQLite keeps for the process (S1 of r21)", () => {
	it.each(ENGINES)("on $name", async (engine) => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "comb-pragma-probe-"))
		try {
			expect(await processScoped(engine, dir)).toEqual([...PROCESS_PRAGMAS].sort())
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
