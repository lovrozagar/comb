import * as z from "zod"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	type CombMigrateConfig,
	createProvider,
	DEFAULT_PG_DEV_URL,
	defineConfig,
	findConfigFile,
	parseConfig,
	loadConfig,
	resolveDatabaseConfig,
} from "./config.ts"

describe("migrate/config: defineConfig", () => {
	it("returns its input as it is: loadConfig validates it (P11 of the 0.15.0 review)", () => {
		const input: CombMigrateConfig = {
			databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "core", type: "d1" } } },
		}
		expect(defineConfig(input)).toBe(input)
	})

	it("parses valid config with environments", async () => {
		const input: CombMigrateConfig = {
			databases: {
				core: {
					environments: {
						dev: { name: "myapp-core-dev" },
						local: { name: "myapp-core-local" },
					},
					migrationsDir: "./atlas-migrations",
					provider: {
						databaseName: "myapp-core",
						type: "d1",
					},
				},
			},
		}
		const config = await parseConfig(input)
		expect(config.databases.core).toBeDefined()
		expect(config.databases.core.environments).toBeDefined()
	})

	it("parses config with legacy name+provider format", async () => {
		const input: CombMigrateConfig = {
			databases: {
				core: {
					migrationsDir: "./migrations",
					name: "mydb",
					provider: {
						path: "./local.db",
						type: "bun-sqlite",
					},
				},
			},
		}
		const config = await parseConfig(input)
		expect(config.databases.core).toBeDefined()
		expect(config.databases.core.name).toBe("mydb")
	})
})

describe("migrate/config: resolveDatabaseConfig", () => {
	it("resolves environment-specific config", async () => {
		const config = await parseConfig({
			databases: {
				core: {
					environments: {
						dev: {
							name: "myapp-dev",
							provider: { databaseName: "dev-db", type: "d1" },
						},
						local: { name: "myapp-local" },
					},
					migrationsDir: "./migrations",
					provider: { databaseName: "main-db", type: "d1" },
				},
			},
		})

		const resolved = resolveDatabaseConfig(config.databases.core, "dev")
		expect(resolved.name).toBe("myapp-dev")
		expect(resolved.provider.type).toBe("d1")
	})

	it("falls back to database-level provider when env has none", async () => {
		const config = await parseConfig({
			databases: {
				core: {
					environments: {
						local: { name: "local-db" },
					},
					migrationsDir: "./migrations",
					provider: { databaseName: "base-db", type: "d1" },
				},
			},
		})

		const resolved = resolveDatabaseConfig(config.databases.core, "local")
		expect(resolved.name).toBe("local-db")
		expect(resolved.provider.type).toBe("d1")
	})
})

describe("migrate/config: resolveDatabaseConfig refusals", () => {
	it("throws when env required but not provided", async () => {
		const config = await parseConfig({
			databases: {
				core: {
					environments: {
						local: { name: "local-db" },
					},
					migrationsDir: "./migrations",
					provider: { databaseName: "core", type: "d1" },
				},
			},
		})

		expect(() => resolveDatabaseConfig(config.databases.core)).toThrow("--env")
	})

	it("throws for unknown environment", async () => {
		const config = await parseConfig({
			databases: {
				core: {
					environments: {
						local: { name: "local-db" },
					},
					migrationsDir: "./migrations",
					provider: { databaseName: "core", type: "d1" },
				},
			},
		})

		expect(() => resolveDatabaseConfig(config.databases.core, "staging")).toThrow('Environment "staging" not found')
	})

	/* M20 of the 0.12 round */
	it("refuses -e on a database that declares no environments, rather than resolve its one name", () => {
		const legacy = { migrationsDir: "m", name: "app-dev", provider: { path: "x.db", type: "bun-sqlite" as const } }
		expect(() => resolveDatabaseConfig(legacy, "prod")).toThrow(
			"the database declares no environments, so -e prod names none; drop -e",
		)
	})

	it.each(["constructor", "toString", "__proto__"])(
		"finds no environment named %s through the prototype",
		async (env) => {
			const config = await parseConfig({
				databases: {
					core: {
						environments: { local: { name: "local-db" } },
						migrationsDir: "./m",
						provider: { databaseName: "core", type: "d1" },
					},
				},
			})
			expect(() => resolveDatabaseConfig(config.databases.core, env)).toThrow(`Environment "${env}" not found`)
		},
	)
})

const PROVIDERS = [
	{ apiToken: "t", databaseName: "core", group: "g", org: "o", type: "turso" },
	{ authToken: "a", type: "libsql", url: "file:x.db" },
	{ path: "x.db", type: "bun-sqlite" },
	{ databaseName: "core", local: true, type: "d1" },
] as const

/* K6 of r19: the type required the group the schema and the driver default, so defineConfig refused the default */
describe("a turso provider without a group", () => {
	const config = defineConfig({
		databases: {
			core: {
				migrationsDir: "m",
				name: "core",
				provider: { apiToken: "t", databaseName: "core", org: "o", type: "turso" },
			},
		},
	})

	it("compiles through defineConfig, and loads with the default", async () => {
		expect((await parseConfig(config)).databases.core?.provider).toMatchObject({ group: "default" })
	})
})

describe("resolveDatabaseConfig and createProvider — every provider", () => {
	it.each(PROVIDERS)("resolves and creates $type with its dialect", (provider) => {
		const resolved = resolveDatabaseConfig({ migrationsDir: "m", name: "core", provider })
		expect(resolved).toEqual({ drizzleConfigPath: undefined, migrationsDir: "m", name: "core", provider })
		expect(createProvider(provider, { run: () => ({ code: 0, stderr: "", stdout: "[]" }) }).dialect).toBe("sqlite")
	})

	it("refuses an environment with no provider anywhere", () => {
		expect(() => resolveDatabaseConfig({ environments: { dev: { name: "d" } }, migrationsDir: "m" }, "dev")).toThrow(
			'No provider config for environment "dev"',
		)
	})

	it("names the environments when none is given", () => {
		const db = {
			environments: { local: { name: "l" }, staging: { name: "s" } },
			migrationsDir: "m",
			provider: PROVIDERS[2],
		}
		expect(() => resolveDatabaseConfig(db)).toThrow("pass -e/--env with one of: local, staging")
	})
})

const PG_URL = "postgres://app@db.example.com/app?sslmode=verify-full"

describe("defineConfig and resolveDatabaseConfig — a Postgres provider", () => {
	it("resolves a postgres provider with comb's defaults for what it leaves out", async () => {
		const config = await parseConfig({
			databases: { core: { migrationsDir: "m", name: "core", provider: { type: "postgres", url: PG_URL } } },
		})
		expect(resolveDatabaseConfig(config.databases["core"] as never).provider).toEqual({
			devUrl: DEFAULT_PG_DEV_URL,
			lockTimeout: "5s",
			schema: "public",
			type: "postgres",
			url: PG_URL,
		})
		expect(DEFAULT_PG_DEV_URL).toBe("docker://postgres/17/dev")
	})

	it("keeps what each environment sets, and takes the database-level provider for the rest", async () => {
		const provider = {
			devUrl: "postgres://localhost/dev",
			lockTimeout: "2s",
			schema: "app",
			type: "postgres",
			url: PG_URL,
		} as const
		const config = await parseConfig({
			databases: {
				core: {
					environments: {
						prod: { name: "core-prod", provider: { ...provider, url: "postgres://app@prod.example.com/app" } },
						staging: { name: "core-staging" },
					},
					migrationsDir: "m",
					provider,
				},
			},
		})
		const db = config.databases["core"] as never
		expect(resolveDatabaseConfig(db, "staging").provider).toEqual(provider)
		expect(resolveDatabaseConfig(db, "prod").provider).toMatchObject({
			schema: "app",
			url: "postgres://app@prod.example.com/app",
		})
	})
})

describe("defineConfig and createProvider — Postgres refusals and neighbors", () => {
	it("refuses neon, which is a postgres URL, and a postgres provider without a url", async () => {
		const neon = { databases: { core: { migrationsDir: "m", name: "core", provider: { type: "neon", url: PG_URL } } } }
		await expect(parseConfig(neon as never)).rejects.toThrow(
			"Neon and Supabase are postgres URLs: use the postgres provider type",
		)
		const bare = { databases: { core: { migrationsDir: "m", name: "core", provider: { type: "postgres" } } } }
		await expect(parseConfig(bare as never)).rejects.toThrow()
	})

	it("holds a SQLite and a Postgres database side by side", async () => {
		const config = await parseConfig({
			databases: {
				analytics: { migrationsDir: "pg", name: "analytics", provider: { type: "postgres", url: PG_URL } },
				core: { migrationsDir: "m", name: "core", provider: { type: "libsql", url: "file:core.db" } },
			},
		})
		expect(resolveDatabaseConfig(config.databases["analytics"] as never).provider.type).toBe("postgres")
		expect(resolveDatabaseConfig(config.databases["core"] as never).provider.type).toBe("libsql")
	})

	it("creates no connection provider for Postgres, which Atlas applies", () => {
		const resolved = resolveDatabaseConfig({
			migrationsDir: "m",
			name: "a",
			provider: { type: "postgres", url: PG_URL },
		})
		// @ts-expect-error createProvider takes the providers comb connects to itself
		expect(() => createProvider(resolved.provider)).toThrow(
			"Atlas applies Postgres migrations; comb opens no connection to postgres",
		)
	})
})

describe("parseConfig — the rest of the input", () => {
	it("refuses a database of one target without its provider", async () => {
		await expect(parseConfig({ databases: { core: { migrationsDir: "m", name: "core" } } })).rejects.toThrow(
			"a database without environments needs a provider",
		)
	})

	/* C5 of the 0.14.1 review: nothing read either, so a config that sets one is refused, not silently run on one database */
	it("refuses multiTenant and promotionOrder, which no command reads, by name", async () => {
		const tenants = { enabled: true, rootDatabase: "root", tenantQuery: "SELECT 1" }
		await expect(parseConfig({ databases: {}, multiTenant: tenants } as never)).rejects.toThrow("multiTenant")
		const promoted = { core: { migrationsDir: "m", promotionOrder: ["staging", "production"] } }
		await expect(parseConfig({ databases: promoted } as never)).rejects.toThrow("promotionOrder")
	})
})

const project = () => mkdtempSync(join(tmpdir(), "comb-migrate-config-"))

/* a database a config file names, as source text */
const DB = '{ migrationsDir: "m", name: "local", provider: { path: "db.sqlite", type: "bun-sqlite" } }'

describe("findConfigFile and loadConfig", () => {
	it("finds comb.migrate.config.ts first, and nothing in a project without one", () => {
		const dir = project()
		try {
			expect(findConfigFile(dir)).toBeUndefined()
			writeFileSync(join(dir, "migration.config.ts"), "export default {}\n")
			writeFileSync(join(dir, "comb.migrate.config.ts"), "export default {}\n")
			expect(findConfigFile(dir)).toBe(join(dir, "comb.migrate.config.ts"))
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("loads a default object, a default function, sync or async, or the module itself, relative to cwd", async () => {
		const dir = project()
		try {
			writeFileSync(join(dir, "a.config.ts"), `export default { databases: { a: ${DB} } }\n`)
			writeFileSync(join(dir, "b.config.ts"), `export default () => ({ databases: { b: ${DB} } })\n`)
			writeFileSync(join(dir, "c.config.ts"), `export const databases = { c: ${DB} }\n`)
			/* M23 of the 0.12 round: a function that returns a promise of the config */
			writeFileSync(join(dir, "d.config.ts"), `export default async () => ({ databases: { d: ${DB} } })\n`)
			for (const [file, key] of [
				["a.config.ts", "a"],
				["b.config.ts", "b"],
				["c.config.ts", "c"],
				["d.config.ts", "d"],
			] as const) {
				const loaded = await loadConfig(file, dir)
				expect(Object.keys(loaded.config.databases)).toEqual([key])
				expect(loaded.configDir).toBe(dir)
			}
			writeFileSync(join(dir, "comb.migrate.config.ts"), `export default { databases: { found: ${DB} } }\n`)
			expect(Object.keys((await loadConfig(undefined, dir)).config.databases)).toEqual(["found"])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("says what is missing: the named file, or any config at all", async () => {
		const dir = project()
		try {
			await expect(loadConfig("nope.config.ts", dir)).rejects.toThrow(
				`Config file not found: ${join(dir, "nope.config.ts")}`,
			)
			await expect(loadConfig(undefined, dir)).rejects.toThrow(
				"No config file found. Create comb.migrate.config.ts (or comb.migrate.config.js)",
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

describe("loadConfig validates what the file exports, however it exports it (M12)", () => {
	it("refuses a mistyped provider in a plain object, a function's result and the module itself, naming the file", async () => {
		const dir = project()
		try {
			const typo = '{ m: { migrationsDir: "m", name: "local", provider: { file: "db.sqlite", type: "bun-sqlite" } } }'
			writeFileSync(join(dir, "a.config.ts"), `export default { databases: ${typo} }\n`)
			writeFileSync(join(dir, "b.config.ts"), `export default () => ({ databases: ${typo} })\n`)
			writeFileSync(join(dir, "c.config.ts"), `export const databases = ${typo}\n`)
			for (const file of ["a.config.ts", "b.config.ts", "c.config.ts"]) {
				const loading = loadConfig(file, dir)
				await expect(loading).rejects.toThrow(`${join(dir, file)} is not a valid migrate config:`)
				await expect(loadConfig(file, dir)).rejects.toThrow(/databases\.m\.provider\.path/)
			}
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("says where a database with neither a name nor environments falls short", async () => {
		const dir = project()
		try {
			writeFileSync(join(dir, "a.config.ts"), 'export default { databases: { a: { migrationsDir: "m" } } }\n')
			await expect(loadConfig("a.config.ts", dir)).rejects.toThrow(
				"✖ a database without environments needs a name\n  → at databases.a.name\n✖ a database without environments needs a provider\n  → at databases.a.provider",
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	/* KC7 of r22b: a config that failed to load reached the user and --json's refused with nothing naming the file */
	it("names the file a config failed to load from, with what a function threw or the syntax error as its cause", async () => {
		const dir = project()
		try {
			writeFileSync(join(dir, "a.config.ts"), 'export default () => { throw new RangeError("no secret here") }\n')
			const thrown = await loadConfig("a.config.ts", dir).catch((error: unknown) => error)
			expect((thrown as Error).message).toBe(`${join(dir, "a.config.ts")} failed to load: no secret here`)
			expect((thrown as Error).cause).toEqual(new RangeError("no secret here"))
			writeFileSync(join(dir, "b.config.ts"), "export default {\n")
			await expect(loadConfig("b.config.ts", dir)).rejects.toThrow(`${join(dir, "b.config.ts")} failed to load: `)
			writeFileSync(join(dir, "c.config.ts"), "export default () => { throw 7 }\n")
			await expect(loadConfig("c.config.ts", dir)).rejects.toThrow(`${join(dir, "c.config.ts")} failed to load: 7`)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("takes a config defineConfig already made as it is", async () => {
		const dir = project()
		try {
			const made = await parseConfig({
				databases: { a: { migrationsDir: "m", name: "local", provider: { path: "db.sqlite", type: "bun-sqlite" } } },
			})
			writeFileSync(join(dir, "a.config.ts"), `export default ${JSON.stringify(made)}\n`)
			expect((await loadConfig("a.config.ts", dir)).config).toEqual(made)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})

/** A D1 config with its migrations directory under `key`, as a helper builds one where tsc does not look */
const builtWith = (key: string) => ({
	databases: { core: { [key]: "./m", name: "local", provider: { databaseName: "CORE", type: "d1" } } },
})

/* K8 of r19: a config module may export a function, sync or async, and parseConfig refused the form loadConfig takes */
describe("parseConfig: every form a config module exports", () => {
	const core = { migrationsDir: "./m", name: "core", provider: { path: "x.db", type: "bun-sqlite" } }
	const valid = { databases: { core } }

	it.each([
		["an object", valid],
		["a function", () => valid],
		["an async function", async () => valid],
	])("reads %s", async (_form, exported) => {
		await expect(parseConfig(exported)).resolves.toMatchObject({ databases: { core: { migrationsDir: "./m" } } })
	})

	it("refuses what a function returns as it refuses an object, and passes on what it throws", async () => {
		await expect(parseConfig(async () => ({ databases: { core: { name: "core" } } }))).rejects.toBeInstanceOf(
			z.ZodError,
		)
		await expect(
			parseConfig(() => {
				throw new RangeError("no config here")
			}),
		).rejects.toThrow(new RangeError("no config here"))
	})

	/* K4 of r21: 0.19's `defineConfig(async () => …)` inside a function export returns a function, which no config is */
	it("refuses a function a function export returned, naming the form that types the config", async () => {
		const refused = parseConfig(async () => async () => valid)
		await expect(refused).rejects.toBeInstanceOf(z.ZodError)
		await expect(refused).rejects.toThrow(
			"a config function returned a function: export the config as `export default async () => defineConfig({…})`",
		)
	})
})

/* r18 K6: a program that imports its own config module parses it with the one parse loadConfig runs */
describe("parseConfig, from /migrate", () => {
	it("is the entry's, and refuses an imported config that tsc's excess-property check never reached", async () => {
		const migrate = await import("./index.ts")
		await expect(migrate.parseConfig(builtWith("migrationDir"))).rejects.toThrow("migrationDir")
		expect((await migrate.parseConfig(builtWith("migrationsDir"))).databases["core"]?.migrationsDir).toBe("./m")
	})
})
