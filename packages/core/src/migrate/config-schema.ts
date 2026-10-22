/**
 * The Zod schema comb.migrate.config.ts is validated against: a typo fails at load, not at apply.
 */
import * as z from "zod"
import type { DatabaseConfig, MultiTenantConfig } from "./types.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

/** The empty database Atlas replays Postgres migrations on when a provider names none */
const DEFAULT_PG_DEV_URL = "docker://postgres/17/dev"

const NEON_IS_POSTGRES =
	"Neon and Supabase are postgres URLs: use the postgres provider type with the direct connection URL"

/* Built on use: defineConfig runs once per process, and module scope stays free of work */
const providerInputSchema = () =>
	z.discriminatedUnion("type", [
		z.object({
			apiToken: z.string().min(1),
			group: z.string().min(1).default("default"),
			org: z.string().min(1),
			type: z.literal("turso"),
		}),
		z.object({
			authToken: z.string().optional(),
			type: z.literal("libsql"),
			url: z.string().min(1),
		}),
		z.object({
			path: z.string().min(1),
			type: z.literal("bun-sqlite"),
		}),
		z.object({
			devUrl: z.string().min(1).optional(),
			lockTimeout: z.string().min(1).optional(),
			schema: z.string().min(1).optional(),
			type: z.literal("postgres"),
			url: z.string().min(1),
		}),
		/* there is no neon type: a Neon or Supabase database is a postgres URL */
		z.object({ type: z.literal("neon") }).transform((_, ctx) => {
			ctx.addIssue({ code: "custom", message: NEON_IS_POSTGRES })
			return z.NEVER
		}),
		z.object({
			/* 0.8 required it and never read it; refused by name, so a config that still passes one learns why */
			databaseId: z
				.never({
					error:
						"databaseId is gone: wrangler finds the database by databaseName and the wrangler config's database_id",
				})
				.optional(),
			databaseName: z.string().min(1),
			local: z.boolean().optional(),
			type: z.literal("d1"),
			wranglerConfig: z.string().min(1).optional(),
			wranglerEnv: z.string().min(1).optional(),
		}),
	])

const environmentConfigInputSchema = () =>
	z.object({
		name: z.string().min(1),
		provider: providerInputSchema().optional(),
	})

const databaseConfigInputSchema = () =>
	z.object({
		codegen: z.string().min(1).optional(),
		drizzleConfigPath: z.string().optional(),
		environments: z.record(z.string(), environmentConfigInputSchema()).optional(),
		migrationsDir: z.string().min(1),
		name: z.string().min(1).optional(),
		provider: providerInputSchema().optional(),
	})

const multiTenantConfigInputSchema = () =>
	z.object({
		circuitBreaker: z
			.object({
				failureThreshold: z.number().min(0).max(1).default(0.1),
				minSampleSize: z.number().int().min(1).default(50),
			})
			.optional(),
		concurrency: z.number().int().min(1).max(200).default(50),
		enabled: z.literal(true),
		rootDatabase: z.string().min(1),
		tenantQuery: z.string().min(1),
	})

/** What comb.migrate.config.ts declares: the migration config before multi-tenant defaults fill in */
type CombMigrateConfig = {
	databases: Record<string, DatabaseConfig>
	multiTenant?:
		| (Omit<MultiTenantConfig, "circuitBreaker"> & {
				circuitBreaker?: MultiTenantConfig["circuitBreaker"] | undefined
		  })
		| undefined
}

/* typed with the declared config, so the schema cannot drift from it */
const configInputSchema = (): z.ZodType<CombMigrateConfig> =>
	z.object({
		databases: z.record(z.string(), databaseConfigInputSchema()),
		multiTenant: multiTenantConfigInputSchema().optional(),
	})

export { type CombMigrateConfig, configInputSchema, DEFAULT_PG_DEV_URL }
