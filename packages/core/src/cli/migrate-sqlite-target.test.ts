import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectionProviderConfig } from "../migrate/types.ts"
import type { ParsedArgs } from "./args.ts"
import { openSqliteTarget } from "./migrate-sqlite-target.ts"

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

	it("writes through the connection it reads on, for an engine other than Turso", async () => {
		const target = await openSqliteTarget(request("apply"), resolved({ type: "libsql", url: ":memory:" }))
		expect(await target.write()).toBe(target.conn)
		await target.close()
	})

	it("passes on a Turso failure that is not a missing database", async () => {
		vi.stubGlobal("fetch", async () => Response.json({ error: "boom" }, { status: 500 }))
		await expect(openSqliteTarget(request("apply"), resolved(TURSO))).rejects.toThrow(
			'Turso API error for "acme/core": boom',
		)
	})
})
