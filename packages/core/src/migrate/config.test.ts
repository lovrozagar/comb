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
						databaseId: "abc123",
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
							provider: { databaseId: "dev123", databaseName: "dev-db", type: "d1" },
						},
						local: { name: "myapp-local" },
					},
					migrationsDir: "./migrations",
					provider: { databaseId: "main123", databaseName: "main-db", type: "d1" },
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
					provider: { databaseId: "base123", databaseName: "base-db", type: "d1" },
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
})

const PROVIDERS = [
	{ apiToken: "t", group: "g", org: "o", type: "turso" },
	{ authToken: "a", type: "libsql", url: "file:x.db" },
	{ path: "x.db", type: "bun-sqlite" },
	{ databaseId: "id", databaseName: "core", local: true, type: "d1" },
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

	it("loads a default object, a default function, or the module itself, relative to cwd", async () => {
		const dir = project()
		try {
			writeFileSync(join(dir, "a.config.ts"), "export default { databases: { a: {} } }\n")
			writeFileSync(join(dir, "b.config.ts"), "export default () => ({ databases: { b: {} } })\n")
			writeFileSync(join(dir, "c.config.ts"), "export const databases = { c: {} }\n")
			for (const [file, key] of [
				["a.config.ts", "a"],
				["b.config.ts", "b"],
				["c.config.ts", "c"],
			] as const) {
				const loaded = await loadConfig(file, dir)
				expect(Object.keys(loaded.config.databases)).toEqual([key])
				expect(loaded.configDir).toBe(dir)
			}
			writeFileSync(join(dir, "comb.migrate.config.ts"), "export default { databases: { found: {} } }\n")
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
