/* C5 of the 0.14.1 review: the config types offer no key that no command reads */
import { expectTypeOf } from "vitest"
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

/* K4 of r21: defineConfig takes an object, and a config that reads its secrets wraps the call, so TypeScript holds
   the object to its known keys in each form; 0.19's function overload let a typo through a returned literal */
const CORE = {
	databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "core", type: "d1" } } },
} as const

export const forms: [CombMigrateConfig, () => CombMigrateConfig, () => Promise<CombMigrateConfig>] = [
	defineConfig(CORE),
	() => defineConfig(CORE),
	async () => defineConfig(CORE),
]

/* the README's own spelling: literals written inline, which no `as const` keeps narrow, so each form's `type` takes
   its contextual type from defineConfig */
export const inline: [CombMigrateConfig, () => CombMigrateConfig, () => Promise<CombMigrateConfig>] = [
	defineConfig({
		databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } } },
	}),
	() =>
		defineConfig({
			databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } } },
		}),
	async () =>
		defineConfig({
			databases: {
				core: { migrationsDir: "m", name: "core", provider: { databaseName: process.env["DB"] ?? "CORE", type: "d1" } },
			},
		}),
]

/* it returns what it was given */
declare const object: CombMigrateConfig
expectTypeOf(defineConfig(object)).toEqualTypeOf<CombMigrateConfig>()

/* 0.19's form, a function passed to defineConfig, is refused (TS2345); the rewrite moves the call inside it */
// @ts-expect-error defineConfig takes no function
export const wrappedSync = defineConfig(() => CORE)
// @ts-expect-error defineConfig takes no async function
export const wrappedAsync = defineConfig(async () => ({ databases: {} }))

/* a misspelled `local` (`lcoal`) or `migrationsDir`, refused in each form, an arrow's body or a block's */
// @ts-expect-error a typo in an object config is caught
export const typoObject = defineConfig({ databses: {} })
export const typoSync = () =>
	defineConfig({
		databases: {
			// @ts-expect-error a misspelled optional key in a sync config is caught
			core: { migrationDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } },
		},
	})
export const typoAsync = async () =>
	defineConfig({
		databases: {
			// @ts-expect-error a misspelled provider key in an async config is caught
			core: { migrationsDir: "m", name: "core", provider: { databaseName: "CORE", lcoal: true, type: "d1" } },
		},
	})
export const typoBlock = async () => {
	const token = await Promise.resolve("t")
	return defineConfig({
		databases: {
			core: {
				migrationsDir: "m",
				// @ts-expect-error a misspelled optional key in a block-bodied async config is caught
				migrationDir: token,
				name: "core",
				provider: { databaseName: "CORE", type: "d1" },
			},
		},
	})
}
export const typoOptional = defineConfig({
	databases: {
		// @ts-expect-error a misspelled optional key in an object config is caught
		core: { drizzleConfigPth: "d", migrationsDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } },
	},
})
