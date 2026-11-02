import { describe, expect, it } from "vitest"
import { configInputSchema, DEFAULT_PG_DEV_URL } from "./config-schema.ts"

/** A config whose one database is the D1 provider with `provider`'s fields */
const d1 = (provider: Record<string, unknown>) => () =>
	configInputSchema().parse({
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
		expect(() => configInputSchema().parse(config as never)).toThrow(key)
	})
})

/* r18 P9: a connection string's content is checked when a command resolves its environment, so one unset in this shell blocks no other */
describe("migrateConfigSchema: connection strings empty at load", () => {
	it.each([
		["a postgres devUrl", { devUrl: "", type: "postgres", url: "postgres://localhost/app" }],
		["a libsql url", { type: "libsql", url: "" }],
		["a turso apiToken", { apiToken: "", databaseName: "core", org: "o", type: "turso" }],
	])("loads %s that is empty", (_, provider) => {
		const config = {
			databases: { core: { environments: { dev: { provider }, prod: { provider } }, migrationsDir: "m" } },
		}
		expect(() => configInputSchema().parse(config)).not.toThrow()
	})
})

/* r18 K4 ⊃ S5: what a config states in itself is refused at load, naming the key */
/** A config of one bun:sqlite database, with `extra` on it */
const coreWith = (extra: Record<string, unknown>) => ({
	databases: { core: { migrationsDir: "./m", name: "core", provider: { path: "x.db", type: "bun-sqlite" }, ...extra } },
})

describe("parseConfig: values refused at load", () => {
	it.each([
		[
			coreWith({ drizzleConfigPath: "" }),
			"drizzleConfigPath is empty; remove it to use the project's drizzle.config.ts, or name the file",
		],
		[
			coreWith({ drizzleConfigPath: "   " }),
			"drizzleConfigPath is empty; remove it to use the project's drizzle.config.ts, or name the file",
		],
		[{ databases: {} }, "databases declares no database"],
		[
			{
				databases: {
					core: { environments: { "": { provider: { path: "x.db", type: "bun-sqlite" } } }, migrationsDir: "./m" },
				},
			},
			"an environment needs a name: -e cannot choose one keyed by a blank string",
		],
		[
			{
				databases: {
					core: { migrationsDir: "./m", name: "core", provider: { lockTimeout: "5 sec", type: "postgres", url: "" } },
				},
			},
			"lockTimeout must be a Postgres duration",
		],
		[
			{
				databases: {
					core: { migrationsDir: "./m", name: "core", provider: { lockTimeout: "25d", type: "postgres", url: "" } },
				},
			},
			"lockTimeout 25d is longer than Postgres's lock_timeout takes",
		],
	])("refuses %j", (config, message) => {
		expect(() => configInputSchema().parse(config)).toThrow(message)
	})
})

/* r18 K2: a Turso provider names its own database; the environment's name is a label */
describe("parseConfig: the turso provider's databaseName", () => {
	it("refuses a turso provider without it, saying to move the database's name there", () => {
		const config = {
			databases: {
				core: {
					environments: { prod: { name: "core-prod", provider: { apiToken: "t", org: "o", type: "turso" } } },
					migrationsDir: "./m",
				},
			},
		}
		expect(() => configInputSchema().parse(config)).toThrow(
			"the turso provider names its database by databaseName: move the Turso database's name there (0.16 read it from the environment's name)",
		)
	})
})

/* K7 of r19 (K4's siblings): every name and path a config states is held to one rule, non-blank, at load */
/** A provider of each kind with `extra` on it */
const d1With = (extra: Record<string, unknown>) => ({ databaseName: "core", type: "d1", ...extra })
const tursoWith = (extra: Record<string, unknown>) => ({
	apiToken: "t",
	databaseName: "core",
	org: "acme",
	type: "turso",
	...extra,
})
const pgWith = (extra: Record<string, unknown>) => ({ type: "postgres", url: "", ...extra })

describe("parseConfig: a blank name or path, wherever the config states one", () => {
	it.each([
		["migrationsDir", { databases: { core: { migrationsDir: "  ", provider: { path: "x.db", type: "bun-sqlite" } } } }],
		["name", coreWith({ name: " " })],
		["codegen", coreWith({ codegen: "\t" })],
		["path", coreWith({ provider: { path: "  ", type: "bun-sqlite" } })],
		["databaseName", coreWith({ provider: d1With({ databaseName: "   " }) })],
		["wranglerConfig", coreWith({ provider: d1With({ wranglerConfig: " " }) })],
		["wranglerEnv", coreWith({ provider: d1With({ wranglerEnv: " " }) })],
		["databaseName", coreWith({ provider: tursoWith({ databaseName: "  " }) })],
		["org", coreWith({ provider: tursoWith({ org: " " }) })],
		["group", coreWith({ provider: tursoWith({ group: " " }) })],
		["schema", coreWith({ provider: pgWith({ schema: "  " }) })],
		["environments", coreWith({ environments: { "  ": { provider: { path: "x.db", type: "bun-sqlite" } } } })],
	])("refuses a blank %s, naming it", (field, config) => {
		expect(() => configInputSchema().parse(config)).toThrow(
			new RegExp(`${field}.*blank|blank.*${field}|an environment needs a name`, "s"),
		)
	})
})
