/**
 * Plan 16's phase 6, from the 0.15.0 review:
 * - P11 = K12: a config written with defineConfig failed with zod's raw issue dump, which names no
 *   file, while a plain object got loadConfig's readable message.
 * - K13: three contradictory or incomplete databases loaded, and failed only at use.
 * - P5: every environment's URL was required at load, so an unset prod URL blocked `-e dev`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig, resolveDatabaseConfig } from "./config.ts"

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true })
})

/** A comb.migrate.config.ts exporting `body`, its path */
function configFile(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), "comb-config-shapes-"))
	dirs.push(dir)
	const file = join(dir, "comb.migrate.config.ts")
	writeFileSync(file, body)
	return file
}

const DEFINED = (databases: string) =>
	`import { defineConfig } from "${join(import.meta.dirname, "index.ts")}"\nexport default defineConfig({ databases: ${databases} })\n`

describe("loadConfig on a config defineConfig wrote", () => {
	it("refuses a typo with the same readable message a plain object gets, naming the file", async () => {
		const file = configFile(
			DEFINED(
				`{ core: { migrationsDir: "m", name: "core", provider: { type: "postgres", url: "postgres://db/app", lockTimout: "5s" } } }`,
			),
		)
		await expect(loadConfig(file)).rejects.toThrow(
			`${file} is not a valid migrate config:\n✖ Unrecognized key: "lockTimout"\n  → at databases.core.provider`,
		)
	})
})

describe("loadConfig on a database of neither shape (K13)", () => {
	it.each([
		[
			"environments beside a name",
			`{ core: { migrationsDir: "m", name: "core", provider: { type: "d1", databaseName: "core" }, environments: { dev: {} } } }`,
			"✖ a database with environments names them by their keys; drop its name\n  → at databases.core.name",
		],
		[
			"an environment with no provider anywhere",
			`{ core: { migrationsDir: "m", environments: { dev: {} } } }`,
			"✖ environment dev has no provider, and the database gives none\n  → at databases.core.environments.dev.provider",
		],
		[
			"no environment",
			`{ core: { migrationsDir: "m", provider: { type: "d1", databaseName: "core" }, environments: {} } }`,
			"✖ environments names none; name one, or give the database a name and a provider instead\n  → at databases.core.environments",
		],
		[
			"no name and no environments",
			`{ core: { migrationsDir: "m", provider: { type: "d1", databaseName: "core" } } }`,
			"✖ a database without environments needs a name\n  → at databases.core.name",
		],
	])("refuses %s at load, naming where", async (_, databases, message) => {
		const file = configFile(DEFINED(databases))
		await expect(loadConfig(file)).rejects.toThrow(`${file} is not a valid migrate config:\n${message}`)
	})

	it("names an environment by its key when it gives no name of its own", async () => {
		const file = configFile(
			DEFINED(
				`{ core: { migrationsDir: "m", provider: { type: "d1", databaseName: "core" }, environments: { dev: {}, prod: { name: "core-prod" } } } }`,
			),
		)
		const { core } = (await loadConfig(file)).config.databases
		expect([resolveDatabaseConfig(core!, "dev").name, resolveDatabaseConfig(core!, "prod").name]).toEqual([
			"dev",
			"core-prod",
		])
	})
})

describe("loadConfig on an environment whose URL is unset (P5)", () => {
	it("loads it, and resolves the others", async () => {
		const file = configFile(
			DEFINED(`{ core: { migrationsDir: "m", environments: {
	dev: { provider: { type: "postgres", url: "postgres://u@db/dev" } },
	prod: { provider: { type: "postgres", url: process.env["COMB_NO_SUCH_URL"] ?? "" } },
} } }`),
		)
		const { core } = (await loadConfig(file)).config.databases
		expect(resolveDatabaseConfig(core!, "dev").provider).toMatchObject({ url: "postgres://u@db/dev" })
	})
})
