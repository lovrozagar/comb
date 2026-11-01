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
		label: "core",
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

const TURSO = { apiToken: "fake", group: "default", org: "acme", type: "turso" as const }

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

	/* r18 S3: a refused apply on a file engine created the file, which check and status then read as empty */
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
	})

	it("passes on a Turso failure that is not a missing database", async () => {
		vi.stubGlobal("fetch", async () => Response.json({ error: "boom" }, { status: 500 }))
		await expect(openSqliteTarget(request("apply"), resolved(TURSO))).rejects.toThrow(
			'Turso API error for "acme/core": boom',
		)
	})
})
