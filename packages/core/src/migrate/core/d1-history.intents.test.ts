/**
 * S1 of r20: apply records each pending file's hash before wrangler runs it (S3 of r19), and a
 * record of a file wrangler has not run is an intent, never proof of what ran. It lives in its own
 * table until wrangler's names the file, so a lost apply, a fixed file and a wrangler-only apply end
 * in the warning `--hashes` clears, not in a database every command refuses.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { asWrangler, fakeD1, localD1, wranglerBin, writeSum } from "../../cli/__fixtures__/d1.ts"
import { createD1Provider } from "../drivers/d1.ts"
import { introspectSqliteSchema } from "../drivers/sqlite.ts"
import { approveMigration } from "./approval.ts"
import type { D1Target, ReadConfig } from "./d1-binding.ts"
import { adoptHashesD1, applyD1, statusD1 } from "./d1-history.ts"
import { d1HistoryTables } from "./d1-history-tables.ts"

const INTENTS = "_comb_migration_hash_intents"
const WRITE = /^--command=(?:CREATE|INSERT|DELETE|UPDATE|DROP|ALTER)\b/m

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-d1-intents-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const approve = (migration: Parameters<typeof approveMigration>[0]) =>
	approveMigration(migration, { target: "core", yes: true })

/**
 * Whether to lose a wrangler call, answered as a reset connection: `true` runs none of it; a string
 * runs a command's statements up to the first that starts with it, as wrangler runs no command as
 * one transaction
 */
type Lose = (args: readonly string[]) => boolean | string

const RESET = { code: 1, stderr: "✘ [ERROR] fetch failed: ECONNRESET", stdout: "" }

/** `args` with its command cut before the first statement that starts with `at`, if any does */
function cut(args: readonly string[], at: string): string[] {
	return args.map((arg) => {
		if (!arg.startsWith("--command=")) return arg
		const statements = arg.slice("--command=".length).split(";\n")
		const end = statements.findIndex((sql) => sql.startsWith(at))
		return `--command=${(end === -1 ? statements : statements.slice(0, end)).join(";\n")}`
	})
}

const read: ReadConfig = () => ({ d1_databases: [{ binding: "CORE" }] })

/** The lines `command` prints */
async function lines(command: (print: (line: string) => void) => Promise<unknown>): Promise<string[]> {
	const out: string[] = []
	await command((line) => out.push(line))
	return out
}

/** A local D1 with migrations in dir/migrations, on a fake wrangler whose calls `lose` picks are lost */
async function target() {
	const migrations = join(dir, "migrations")
	mkdirSync(migrations)
	const fake = fakeD1({ dir: migrations })
	const state: { lose: Lose } = { lose: () => false }
	const run = Object.assign(
		asWrangler((cmd, args, options) => {
			const lose = cmd === "wrangler" && state.lose(args)
			if (lose === false) return fake(cmd, [...args], options)
			if (typeof lose === "string") fake(cmd, cut(args, lose), options)
			return RESET
		}),
		{ calls: fake.calls, db: fake.db },
	)
	const config = { databaseName: "core", local: true, type: "d1" as const }
	const conn = await createD1Provider(config, run).connect({
		migrationsDir: migrations,
		name: "core",
		provider: config,
	})
	localD1(dir, { binding: "CORE" })
	const d1: D1Target = {
		conn,
		exec: run,
		flags: ["--local"],
		migrationsDir: migrations,
		name: "CORE",
		wrangler: wranglerBin(),
		wranglerConfig: join(dir, "wrangler.toml"),
	}
	const file = (name: string, sql: string) => {
		writeFileSync(join(migrations, name), sql)
		writeSum(migrations)
	}
	return {
		apply: (print: (line: string) => void = () => undefined) => applyD1(d1, { approve, print, read }),
		check: () => applyD1(d1, { approve, checkOnly: true, print: () => undefined, read }),
		d1,
		file,
		hashes: () => run.db.prepare("SELECT name, hash FROM _comb_migration_hashes ORDER BY name").all(),
		intents: () =>
			run.db.prepare("SELECT name FROM sqlite_master WHERE name = ?").all(INTENTS).length === 0
				? undefined
				: run.db.prepare(`SELECT name FROM ${INTENTS} ORDER BY name`).all(),
		lines,
		lose: (lose: Lose) => {
			state.lose = lose
		},
		read,
		run,
		/** what wrangler itself applies, as `wrangler d1 migrations apply` run by hand */
		wranglerApply: () => fake("wrangler", ["d1", "migrations", "apply", "CORE", "--local"], { input: "" }),
		writes: () => run.calls.filter((call) => call.some((arg) => WRITE.test(arg))).length,
	}
}

const migrationsApply = (args: readonly string[]) => args[1] === "migrations"

describe("a pre-recorded hash never outlives a lost apply (S1); sibling: a lost move", () => {
	it("a lost apply, a fixed pending file and a wrangler-only apply end in the warning --hashes clears", async () => {
		const t = await target()
		t.file("0001_t1.sql", "CREATE TABLE t1 (id INTEGER);")
		await t.apply()
		t.file("0002_t2.sql", "CREATE TABLE t2 (id INTEGER);")
		t.lose(migrationsApply)
		await expect(t.apply()).rejects.toThrow(/ECONNRESET/)
		t.lose(() => false)
		t.file("0002_t2.sql", "CREATE TABLE t2 (id INTEGER, fixed INTEGER);")
		expect(t.wranglerApply().code).toBe(0)
		const status = await t.lines((print) => statusD1(t.d1, t.read, print))
		expect(status).toEqual([
			"Applied: 0001_t1.sql, 0002_t2.sql",
			"Pending: none",
			"No hash recorded for 0002_t2.sql, applied before comb recorded them: comb cannot tell whether it was edited since",
		])
		expect(await t.check()).toEqual([])
		expect(await t.lines((print) => adoptHashesD1(t.d1, t.read, print))).toEqual(["Hash recorded: 0002_t2.sql"])
		expect(await t.lines((print) => statusD1(t.d1, t.read, print))).toEqual([
			"Applied: 0001_t1.sql, 0002_t2.sql",
			"Pending: none",
		])
		expect(t.intents()).toEqual([])
	})

	it("after a lost move, a read counts a matching intent as hashed and an edited one as unhashed, writing nothing; the next apply moves it", async () => {
		const t = await target()
		t.file("0001_t1.sql", "CREATE TABLE t1 (id INTEGER);")
		t.file("0002_t2.sql", "CREATE TABLE t2 (id INTEGER);")
		let applied = false
		t.lose((args) => {
			if (migrationsApply(args)) applied = true
			return applied && args.some((arg) => arg.startsWith("--command=") && arg.includes(INTENTS))
		})
		await expect(t.apply()).rejects.toThrow(/ECONNRESET/)
		t.lose(() => false)
		expect(t.intents()).toEqual([{ name: "0001_t1.sql" }, { name: "0002_t2.sql" }])
		const before = t.writes()
		expect(await t.lines((print) => statusD1(t.d1, t.read, print))).toEqual([
			"Applied: 0001_t1.sql, 0002_t2.sql",
			"Pending: none",
		])
		expect(await t.check()).toEqual([])
		t.file("0002_t2.sql", "CREATE TABLE t2 (id INTEGER, edited INTEGER);")
		expect(await t.lines((print) => statusD1(t.d1, t.read, print))).toEqual([
			"Applied: 0001_t1.sql, 0002_t2.sql",
			"Pending: none",
			"No hash recorded for 0002_t2.sql, applied before comb recorded them: comb cannot tell whether it was edited since",
		])
		expect(t.writes()).toBe(before)
		expect(await t.apply()).toEqual([])
		expect(t.hashes().map((row) => row["name"])).toEqual(["0001_t1.sql"])
		expect(t.intents()).toEqual([])
	})
})

describe("the intent table (S1): a cut move, a D1 without it, comb's own", () => {
	it("an apply that loses its move after wrangler leaves no intent half moved: each name keeps its intent or its hash", async () => {
		const t = await target()
		t.file("0001_t1.sql", "CREATE TABLE t1 (id INTEGER);")
		let applied = false
		/* the move's last statement, the intents' delete, is lost after its hashes landed */
		t.lose((args) => {
			if (migrationsApply(args)) applied = true
			return applied && args.some((arg) => arg.includes(`DELETE FROM ${INTENTS}`)) ? "DELETE" : false
		})
		await expect(t.apply()).rejects.toThrow(/ECONNRESET/)
		t.lose(() => false)
		expect(t.hashes().map((row) => row["name"])).toEqual(["0001_t1.sql"])
		expect(t.intents()).toEqual([{ name: "0001_t1.sql" }])
		expect(await t.lines((print) => statusD1(t.d1, t.read, print))).toEqual(["Applied: 0001_t1.sql", "Pending: none"])
		expect(await t.apply()).toEqual([])
		expect(t.intents()).toEqual([])
	})

	it("status and check on a D1 without the intent table read cleanly and create nothing", async () => {
		const t = await target()
		t.file("0001_t1.sql", "CREATE TABLE t1 (id INTEGER);")
		await t.apply()
		t.run.db.exec(`DROP TABLE ${INTENTS}`)
		t.file("0002_t2.sql", "CREATE TABLE t2 (id INTEGER);")
		const before = t.writes()
		expect(await t.lines((print) => statusD1(t.d1, t.read, print))).toEqual([
			"Applied: 0001_t1.sql",
			"Pending: 0002_t2.sql",
		])
		expect(await t.check()).toEqual(["0002_t2.sql"])
		expect(t.writes()).toBe(before)
		expect(t.intents()).toBeUndefined()
	})

	it("is comb's: a history table, never the user's in the schema the proof runs on, nor in an empty target's count", async () => {
		expect(d1HistoryTables()).toContain(INTENTS)
		const t = await target()
		t.file("0001_t1.sql", "CREATE TABLE t1 (id INTEGER);")
		t.lose(migrationsApply)
		await expect(t.apply()).rejects.toThrow(/ECONNRESET/)
		t.lose(() => false)
		/* the table is there, its intents cleared, as wrangler ran nothing */
		expect(t.intents()).toEqual([])
		expect(await introspectSqliteSchema(t.d1.conn)).not.toContain(INTENTS)
		const out: string[] = []
		expect(await t.apply((line) => out.push(line))).toEqual(["0001_t1.sql"])
		expect(out.join("\n")).toMatch(/Empty target/)
	})
})
