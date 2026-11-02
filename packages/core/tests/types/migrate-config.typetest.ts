/* C5 of the 0.14.1 review: the config types offer no key that no command reads */
import {
	type CombMigrateConfig,
	type DatabaseConfig,
	defineConfig,
	type MigrationConfig,
} from "../../src/migrate/index.ts"

export const promoted: DatabaseConfig = {
	migrationsDir: "m",
	// @ts-expect-error promotionOrder is read by no command
	promotionOrder: ["staging", "production"],
}

export const tenants: MigrationConfig = {
	databases: {},
	// @ts-expect-error multiTenant is read by no command
	multiTenant: {
		circuitBreaker: { failureThreshold: 0.1, minSampleSize: 50 },
		concurrency: 5,
		enabled: true,
		rootDatabase: "r",
		tenantQuery: "q",
	},
}

/* K9 of r20: defineConfig types each form the loader takes, an object or a function, sync or async, that returns one */
const CORE = {
	databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "core", type: "d1" } } },
} as const

export const forms: [CombMigrateConfig, () => CombMigrateConfig, () => Promise<CombMigrateConfig>] = [
	defineConfig(CORE),
	defineConfig(() => CORE),
	defineConfig(async () => CORE),
]

// @ts-expect-error a typo inside an async config is caught
export const typo = defineConfig(async () => ({ databses: {} }))
