/* C5 of the 0.14.1 review: the config types offer no key that no command reads */
import type { DatabaseConfig, MigrationConfig } from "../../src/migrate/index.ts"

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
