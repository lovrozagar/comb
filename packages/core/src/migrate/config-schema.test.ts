import { describe, expect, it } from "vitest"
import { parseConfig } from "./config.ts"
import { configInputSchema, DEFAULT_PG_DEV_URL } from "./config-schema.ts"

/** A config whose one database is the D1 provider with `provider`'s fields */
const d1 = (provider: Record<string, unknown>) => () =>
	parseConfig({
		databases: {
			core: { migrationsDir: "./m", name: "core", provider: { databaseName: "core", type: "d1", ...provider } },
		},
	})

describe("migrate/config: the D1 provider (C2)", () => {
	it("takes a database by its name alone, as wrangler does", () => {
		expect(d1({})).not.toThrow()
	})

	it("refuses databaseId, which it never read, saying what names the database", () => {
		expect(d1({ databaseId: "abc123" })).toThrow(
			"databaseId is gone: wrangler finds the database by databaseName and the wrangler config's database_id",
		)
	})
})

describe("configInputSchema", () => {
	it("defaults Postgres's dev database to Atlas's docker URL, and refuses a neon provider", () => {
		expect(DEFAULT_PG_DEV_URL).toBe("docker://postgres/17/dev")
		const neon = { databases: { core: { migrationsDir: "./m", name: "core", provider: { type: "neon" } } } }
		expect(configInputSchema().safeParse(neon).success).toBe(false)
	})
})

const db = { migrationsDir: "./m", name: "core" }

/** Each level of the config, with a key misspelled on it */
const MISSPELLED: Array<[string, unknown, string]> = [
	["d1", { databases: { core: { ...db, provider: { databaseName: "core", locla: true, type: "d1" } } } }, "locla"],
	[
		"postgres",
		{ databases: { core: { ...db, provider: { devURL: "postgres://d", type: "postgres", url: "postgres://u" } } } },
		"devURL",
	],
	[
		"libsql",
		{ databases: { core: { ...db, provider: { type: "libsql", url: ":memory:", authtoken: "t" } } } },
		"authtoken",
	],
	[
		"turso",
		{ databases: { core: { ...db, provider: { apiToken: "t", org: "o", grup: "g", type: "turso" } } } },
		"grup",
	],
	["bun-sqlite", { databases: { core: { ...db, provider: { path: "x.db", type: "bun-sqlite", wal: true } } } }, "wal"],
	[
		"a database",
		{ databases: { core: { ...db, enviroments: {}, provider: { path: "x.db", type: "bun-sqlite" } } } },
		"enviroments",
	],
	[
		"an environment",
		{
			databases: {
				core: {
					environments: { prod: { name: "p", provder: { path: "x.db", type: "bun-sqlite" } } },
					migrationsDir: "./m",
					provider: { path: "x.db", type: "bun-sqlite" },
				},
			},
		},
		"provder",
	],
	["the top level", { databases: {}, multiTennant: {} }, "multiTennant"],
]

/* M19 of the 0.12 round: a key the config does not know is a typo, refused at load, never dropped for its default */
describe("migrate/config: an unknown key at any level", () => {
	it.each(MISSPELLED)("refuses one on %s, by name", (_level, config, key) => {
		expect(() => parseConfig(config as never)).toThrow(key)
	})
})
