/**
 * The Zod schema comb.migrate.config.ts is validated against: a typo fails at load, not at apply.
 * Every object is strict, so a misspelled key is refused by name rather than dropped for its default.
 */
import * as z from "zod"
import type { DatabaseConfig } from "./types.ts"

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
		z.strictObject({
			apiToken: z.string().min(1),
			group: z.string().min(1).default("default"),
			org: z.string().min(1),
			type: z.literal("turso"),
		}),
		z.strictObject({
			authToken: z.string().optional(),
			type: z.literal("libsql"),
			url: z.string().min(1),
		}),
		z.strictObject({
			path: z.string().min(1),
			type: z.literal("bun-sqlite"),
		}),
		z.strictObject({
			devUrl: z.string().min(1).optional(),
			lockTimeout: z.string().min(1).optional(),
			schema: z.string().min(1).optional(),
			type: z.literal("postgres"),
			/* checked when a command resolves its environment, so one unset in this shell blocks no other (P5) */
			url: z.string(),
		}),
		/* there is no neon type: a Neon or Supabase database is a postgres URL */
		/* loose, so a neon provider's url and other keys reach the message that says what to use instead */
		z.object({ type: z.literal("neon") }).transform((_, ctx) => {
			ctx.addIssue({ code: "custom", message: NEON_IS_POSTGRES })
			return z.NEVER
		}),
		z.strictObject({
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
	z.strictObject({
		name: z.string().min(1).optional(),
		provider: providerInputSchema().optional(),
	})

type DatabaseInput = {
	environments?: Record<string, { provider?: unknown }> | undefined
	name?: string | undefined
	provider?: unknown
}

/** Why a database is of neither shape, each at its path: one target's name and provider, or environments that each resolve a provider (K13) */
function shapeIssues(db: DatabaseInput): Array<{ message: string; path: string[] }> {
	if (db.environments === undefined) {
		return [
			...(db.name === undefined ? [{ message: "a database without environments needs a name", path: ["name"] }] : []),
			...(db.provider === undefined
				? [{ message: "a database without environments needs a provider", path: ["provider"] }]
				: []),
		]
	}
	const environments = Object.entries(db.environments)
	return [
		...(db.name === undefined
			? []
			: [{ message: "a database with environments names them by their keys; drop its name", path: ["name"] }]),
		...(environments.length === 0
			? [
					{
						message: "environments names none; name one, or give the database a name and a provider instead",
						path: ["environments"],
					},
				]
			: []),
		...environments
			.filter(([, env]) => env.provider === undefined && db.provider === undefined)
			.map(([key]) => ({
				message: `environment ${key} has no provider, and the database gives none`,
				path: ["environments", key, "provider"],
			})),
	]
}

const databaseConfigInputSchema = () =>
	z
		.strictObject({
			codegen: z.string().min(1).optional(),
			drizzleConfigPath: z.string().optional(),
			environments: z.record(z.string(), environmentConfigInputSchema()).optional(),
			migrationsDir: z.string().min(1),
			name: z.string().min(1).optional(),
			provider: providerInputSchema().optional(),
		})
		.superRefine((db, ctx) => {
			for (const issue of shapeIssues(db)) ctx.addIssue({ code: "custom", ...issue })
		})
		/* one of the two shapes, which shapeIssues has just held it to */
		.transform((db) => db as DatabaseConfig)

/** What comb.migrate.config.ts declares */
type CombMigrateConfig = {
	databases: Record<string, DatabaseConfig>
}

/* typed with the declared config, so the schema cannot drift from it */
const configInputSchema = (): z.ZodType<CombMigrateConfig> =>
	z.strictObject({
		databases: z.record(z.string(), databaseConfigInputSchema()),
	})

export { type CombMigrateConfig, configInputSchema, DEFAULT_PG_DEV_URL }
