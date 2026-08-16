import { describe, expect, it } from "vitest"
import { type CombMigrateConfig, defineConfig, resolveDatabaseConfig } from "../../../src/migrate/config.ts"

describe("migrate/config", () => {
	describe("defineConfig", () => {
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

	describe("resolveDatabaseConfig", () => {
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
})
