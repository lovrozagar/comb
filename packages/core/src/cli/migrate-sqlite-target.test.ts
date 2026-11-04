import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectionProviderConfig } from "../migrate/types.ts"
import type { ParsedArgs } from "./args.ts"
import { openSqliteTarget } from "./migrate-sqlite-target.ts"

vi.mock("bun:sqlite", () => import("../migrate/__fixtures__/bun-sqlite-node.ts"))

const dirs: string[] = []
afterEach(() => {
	vi.unstubAllGlobals()
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
})

/** A resolved target for `provider`, its migrations directory made */
function resolved(provider: ConnectionProviderConfig) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-sqlite-target-"))
	dirs.push(dir)
	fs.mkdirSync(path.join(dir, "m"))
	return {
		codegen: "core",
		configDir: dir,
		database: "core",
		dialect: "sqlite" as const,
		drizzleConfigPath: undefined,
		label: "core (core_prod)",
		migrationsDir: path.join(dir, "m"),
		name: "core",
		provider,
	}
}

const request = (mode: string, options: ParsedArgs["options"] = {}) => ({
	args: { options, positionals: [] },
	io: { cwd: os.tmpdir(), err: () => undefined, out: () => undefined },
	mode,
})

const TURSO = { apiToken: "fake", databaseName: "core", group: "default", org: "acme", type: "turso" as const }

describe("openSqliteTarget", () => {
	it.each([
		[{ local: true as const }, "--local is for a D1 database"],
		[{ hashes: true as const }, "--hashes is for a D1 database"],
	])("refuses %j, a D1 database's flag", async (options, message) => {
		await expect(openSqliteTarget(request("apply", options), resolved(TURSO))).rejects.toThrow(message)
	})

	it("refuses a migrations directory that does not exist", async () => {
		const target = { ...resolved({ type: "libsql", url: ":memory:" }), migrationsDir: "/nowhere/m" }
		await expect(openSqliteTarget(request("apply"), target)).rejects.toThrow("Migrations dir not found: /nowhere/m")
	})

	it("passes on a Turso failure that is not a missing database", async () => {
		vi.stubGlobal("fetch", async () => Response.json({ error: "boom" }, { status: 500 }))
		await expect(openSqliteTarget(request("apply"), resolved(TURSO))).rejects.toThrow(
			'Turso API error for "acme/core": boom',
		)
	})
})

/* r18 S3: a refused apply on a file engine created the file, which check and status then read as empty */
describe("openSqliteTarget on a database file", () => {
	it.each([
		["libsql", (file: string): ConnectionProviderConfig => ({ type: "libsql", url: `file:${file}` })],
		["bun-sqlite", (file: string): ConnectionProviderConfig => ({ path: file, type: "bun-sqlite" })],
	])("reads a missing %s file as the empty database, and creates it only to write", async (_, provider) => {
		const base = resolved({ type: "libsql", url: ":memory:" })
		const file = path.join(base.configDir, "core.db")
		const target = await openSqliteTarget(request("apply"), { ...base, provider: provider(file) })
		expect((await target.conn.execute("SELECT count(*) AS n FROM sqlite_master")).rows).toEqual([[0]])
		await expect(target.conn.batch([{ sql: "CREATE TABLE t (a)" }])).rejects.toThrow("does not exist yet")
		expect(fs.existsSync(file)).toBe(false)
		const writer = await target.write()
		expect(await target.write()).toBe(writer)
		await writer.batch([{ sql: "CREATE TABLE t (a)" }])
		await target.close()
		expect(fs.existsSync(file)).toBe(true)
	})

	it("reads an existing file on a connection of its own, and writes through another", async () => {
		const base = resolved({ type: "libsql", url: ":memory:" })
		const url = `file:${path.join(base.configDir, "core.db")}`
		const first = await openSqliteTarget(request("apply"), { ...base, provider: { type: "libsql", url } })
		await (await first.write()).batch([{ sql: "CREATE TABLE t (a)" }])
		await first.close()
		const target = await openSqliteTarget(request("baseline"), { ...base, provider: { type: "libsql", url } })
		expect((await target.conn.execute("SELECT name FROM sqlite_master")).rows).toEqual([["t"]])
		expect(await target.write()).not.toBe(target.conn)
		await target.close()
	})

	it("refuses a missing file on check and status, which create none", async () => {
		const base = resolved({ type: "libsql", url: ":memory:" })
		const file = path.join(base.configDir, "core.db")
		for (const mode of ["check", "status"])
			await expect(
				openSqliteTarget(request(mode), { ...base, provider: { path: file, type: "bun-sqlite" } }),
			).rejects.toThrow(`${file} does not exist`)
		expect(fs.existsSync(file)).toBe(false)
		const url = `file:${file}`
		const writer = await openSqliteTarget(request("apply"), { ...base, provider: { type: "libsql", url } })
		await writer.write()
		await writer.close()
		const reader = await openSqliteTarget(request("status"), { ...base, provider: { type: "libsql", url } })
		expect(await reader.write()).toBe(reader.conn)
		expect(await reader.fresh()).toBe(reader.conn)
		await reader.close()
	})
})

/* S1 of r21: each file applies on a connection of its own, so what it sets on the connection ends with it */
describe("openSqliteTarget: a connection per file", () => {
	it.each([
		["libsql", (file: string): ConnectionProviderConfig => ({ type: "libsql", url: `file:${file}` })],
		["bun-sqlite", (file: string): ConnectionProviderConfig => ({ path: file, type: "bun-sqlite" })],
	])(
		"opens a new %s connection for each file, apart from the writer, which sees what each committed",
		async (_, provider) => {
			const base = resolved({ type: "libsql", url: ":memory:" })
			const target = await openSqliteTarget(request("apply"), {
				...base,
				provider: provider(path.join(base.configDir, "core.db")),
			})
			const [writer, one, two] = [await target.write(), await target.fresh(), await target.fresh()]
			expect(new Set([writer, one, two]).size).toBe(3)
			await one.batch([{ sql: "PRAGMA recursive_triggers = 1" }, { sql: "CREATE TABLE t (a)" }])
			await one.close()
			/* a trigger that inserts again recurses only with recursive_triggers on: 1 and 2 when it is off, 1 to 5 when on */
			await two.batch([
				{ sql: "CREATE TABLE c (n INTEGER)" },
				{ sql: "CREATE TRIGGER c_next AFTER INSERT ON c WHEN new.n < 5 BEGIN INSERT INTO c VALUES (new.n + 1); END" },
				{ sql: "INSERT INTO c VALUES (1)" },
			])
			expect((await writer.execute("SELECT count(*) FROM c")).rows).toEqual([[2]])
			expect((await writer.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows).toEqual([["t"], ["c"]])
			await two.close()
			await target.close()
		},
	)

	it.each([
		["libsql", { type: "libsql", url: ":memory:" } as const],
		["libsql file:", { type: "libsql", url: "file::memory:" } as const],
		["bun-sqlite", { path: ":memory:", type: "bun-sqlite" } as const],
	])(
		"applies every file of an in-memory %s database through its one writer, which a file's close leaves open",
		async (_, provider) => {
			const target = await openSqliteTarget(request("apply"), { ...resolved(provider), provider })
			const file = await target.fresh()
			await file.batch([{ sql: "CREATE TABLE t (a)" }])
			await file.close()
			expect((await (await target.write()).execute("SELECT name FROM sqlite_master")).rows).toEqual([["t"]])
			await target.close()
		},
	)
})

/* r18 P9: an empty libsql url or turso apiToken loads, and is refused by the command that would use it; AD9 of the area D review: naming whose it is */
describe("openSqliteTarget on a connection string that is empty", () => {
	it.each([
		[{ type: "libsql" as const, url: "" }, "url is empty: set the libsql provider's url for core (core_prod)"],
		[{ ...TURSO, apiToken: "" }, "apiToken is empty: set the turso provider's apiToken for core (core_prod)"],
		/* S5 of r19: blank is empty, as Postgres's URL check reads it */
		[{ type: "libsql" as const, url: "  " }, "url is empty: set the libsql provider's url for core (core_prod)"],
		[{ ...TURSO, apiToken: " \t" }, "apiToken is empty: set the turso provider's apiToken for core (core_prod)"],
		/* D2-10 of the area D round-two review: a blank authToken went out as a bare Bearer and came back a 401 */
		[
			{ type: "libsql" as const, url: "libsql://x.turso.io", authToken: " " },
			"authToken is empty: set the libsql provider's authToken for core (core_prod)",
		],
		[
			{ type: "libsql" as const, url: "libsql://x.turso.io", authToken: "" },
			"authToken is empty: set the libsql provider's authToken for core (core_prod)",
		],
	])("refuses %j, naming the field and its database", async (provider, message) => {
		await expect(openSqliteTarget(request("status"), resolved(provider))).rejects.toThrow(message)
	})
})
