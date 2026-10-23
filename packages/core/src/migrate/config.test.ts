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
	loadConfig,
	resolveDatabaseConfig,
} from "./config.ts"

describe("migrate/config: defineConfig", () => {
	it("parses valid config with environments", () => {
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
		const config = defineConfig(input)
		expect(config.databases.core).toBeDefined()
		expect(config.databases.core.environments).toBeDefined()
	})

	it("parses config with legacy name+provider format", () => {
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
		const config = defineConfig(input)
		expect(config.databases.core).toBeDefined()
		expect(config.databases.core.name).toBe("mydb")
	})
})

describe("migrate/config: resolveDatabaseConfig", () => {
	it("resolves environment-specific config", () => {
		const config = defineConfig({
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

	it("falls back to database-level provider when env has none", () => {
		const config = defineConfig({
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
	it("throws when env required but not provided", () => {
		const config = defineConfig({
			databases: {
				core: {
					environments: {
						local: { name: "local-db" },
					},
					migrationsDir: "./migrations",
				},
			},
		})

		expect(() => resolveDatabaseConfig(config.databases.core)).toThrow("--env")
	})

	it("throws for unknown environment", () => {
		const config = defineConfig({
			databases: {
				core: {
					environments: {
						local: { name: "local-db" },
					},
					migrationsDir: "./migrations",
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

	it.each(["constructor", "toString", "__proto__"])("finds no environment named %s through the prototype", (env) => {
		const config = defineConfig({
			databases: { core: { environments: { local: { name: "local-db" } }, migrationsDir: "./m" } },
		})
		expect(() => resolveDatabaseConfig(config.databases.core, env)).toThrow(`Environment "${env}" not found`)
	})
})

const PROVIDERS = [
	{ apiToken: "t", group: "g", org: "o", type: "turso" },
	{ authToken: "a", type: "libsql", url: "file:x.db" },
	{ path: "x.db", type: "bun-sqlite" },
	{ databaseName: "core", local: true, type: "d1" },
] as const

describe("resolveDatabaseConfig and createProvider — every provider", () => {
	it.each(PROVIDERS)("resolves and creates $type with its dialect", (provider) => {
		const resolved = resolveDatabaseConfig({ migrationsDir: "m", name: "core", provider })
		expect(resolved).toEqual({ drizzleConfigPath: undefined, migrationsDir: "m", name: "core", provider })
		expect(createProvider(provider, { run: () => ({ code: 0, stderr: "", stdout: "[]" }) }).dialect).toBe("sqlite")
	})

	it("refuses an environment with no provider anywhere, and a legacy config missing name or provider", () => {
		expect(() => resolveDatabaseConfig({ environments: { dev: { name: "d" } }, migrationsDir: "m" }, "dev")).toThrow(
			'No provider config for environment "dev"',
		)
		expect(() => resolveDatabaseConfig({ migrationsDir: "m", provider: PROVIDERS[2] })).toThrow(
			"either 'name' field or 'environments'",
		)
		expect(() => resolveDatabaseConfig({ migrationsDir: "m", name: "core" })).toThrow("must have 'provider'")
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
	it("resolves a postgres provider with comb's defaults for what it leaves out", () => {
		const config = defineConfig({
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

	it("keeps what each environment sets, and takes the database-level provider for the rest", () => {
		const provider = {
			devUrl: "postgres://localhost/dev",
			lockTimeout: "2s",
			schema: "app",
			type: "postgres",
			url: PG_URL,
		} as const
		const config = defineConfig({
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
	it("refuses neon, which is a postgres URL, and a postgres provider without a url", () => {
		const neon = { databases: { core: { migrationsDir: "m", name: "core", provider: { type: "neon", url: PG_URL } } } }
		expect(() => defineConfig(neon as never)).toThrow(
			"Neon and Supabase are postgres URLs: use the postgres provider type",
		)
		const bare = { databases: { core: { migrationsDir: "m", name: "core", provider: { type: "postgres" } } } }
		expect(() => defineConfig(bare as never)).toThrow()
	})

	it("holds a SQLite and a Postgres database side by side", () => {
		const config = defineConfig({
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

describe("defineConfig — the rest of the input", () => {
	it("refuses a legacy database without both name and provider", () => {
		expect(() => defineConfig({ databases: { core: { migrationsDir: "m", name: "core" } } })).toThrow(
			'Database "core": legacy format requires both',
		)
	})

	it("fills in the multi-tenant circuit breaker defaults", () => {
		const config = defineConfig({
			databases: {},
			multiTenant: { concurrency: 5, enabled: true, rootDatabase: "root", tenantQuery: "SELECT 1" },
		})
		expect(config.multiTenant).toEqual({
			circuitBreaker: { failureThreshold: 0.1, minSampleSize: 50 },
			concurrency: 5,
			enabled: true,
			rootDatabase: "root",
			tenantQuery: "SELECT 1",
		})
		expect(defineConfig({ databases: {} }).multiTenant).toBeUndefined()
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
				"No config file found. Create one of: comb.migrate.config.ts",
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

	it("says what defineConfig says of a database with neither a name nor environments", async () => {
		const dir = project()
		try {
			writeFileSync(join(dir, "a.config.ts"), 'export default { databases: { a: { migrationsDir: "m" } } }\n')
			await expect(loadConfig("a.config.ts", dir)).rejects.toThrow(
				`Database "a": legacy format requires both 'name' and 'provider' fields`,
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})

	it("takes a config defineConfig already made as it is", async () => {
		const dir = project()
		try {
			const made = defineConfig({
				databases: { a: { migrationsDir: "m", name: "local", provider: { path: "db.sqlite", type: "bun-sqlite" } } },
			})
			writeFileSync(join(dir, "a.config.ts"), `export default ${JSON.stringify(made)}\n`)
			expect((await loadConfig("a.config.ts", dir)).config).toEqual(made)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
