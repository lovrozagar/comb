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

/* K9 of r20: defineConfig types each form the loader takes, an object or a function, sync or async, that returns one */
const CORE = {
	databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "core", type: "d1" } } },
} as const

export const forms: [CombMigrateConfig, () => CombMigrateConfig, () => Promise<CombMigrateConfig>] = [
	defineConfig(CORE),
	defineConfig(() => CORE),
	defineConfig(async () => CORE),
]

/* the README's own spelling: literals written inline, which no `as const` keeps narrow, so each form's `type` takes
   its contextual type from defineConfig */
export const inline: [CombMigrateConfig, () => CombMigrateConfig, () => Promise<CombMigrateConfig>] = [
	defineConfig({
		databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } } },
	}),
	defineConfig(() => ({
		databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } } },
	})),
	defineConfig(async () => ({
		databases: {
			core: { migrationsDir: "m", name: "core", provider: { databaseName: process.env["DB"] ?? "CORE", type: "d1" } },
		},
	})),
]

/* a target typed ahead of the call infers nothing ahead of the arrow's body */
export const annotated: () => Promise<CombMigrateConfig> = defineConfig(async () => ({
	databases: { core: { migrationsDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } } },
}))

/* it returns what it was given */
declare const object: CombMigrateConfig
declare const sync: () => CombMigrateConfig
declare const async: () => Promise<CombMigrateConfig>
expectTypeOf(defineConfig(object)).toEqualTypeOf<CombMigrateConfig>()
expectTypeOf(defineConfig(sync)).toEqualTypeOf<() => CombMigrateConfig>()
expectTypeOf(defineConfig(async)).toEqualTypeOf<() => Promise<CombMigrateConfig>>()
expectTypeOf(defineConfig(async () => ({ databases: {} }))).toEqualTypeOf<() => Promise<{ databases: {} }>>()

/* a typo in each form: a misspelled key every config needs fails all three; an object written inline is also held to
   its known keys, which TypeScript checks on no literal a function returns, so comb's load refuses those by name */
// @ts-expect-error a typo in an object config is caught
export const typoObject = defineConfig({ databses: {} })
// @ts-expect-error a typo in a sync config is caught
export const typoSync = defineConfig(() => ({ databses: {} }))
// @ts-expect-error a typo in an async config is caught
export const typoAsync = defineConfig(async () => ({ databses: {} }))
export const typoOptional = defineConfig({
	databases: {
		// @ts-expect-error a misspelled optional key in an object config is caught
		core: { drizzleConfigPth: "d", migrationsDir: "m", name: "core", provider: { databaseName: "CORE", type: "d1" } },
	},
})
