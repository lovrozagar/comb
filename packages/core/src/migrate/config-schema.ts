/**
 * The Zod schema comb.migrate.config.ts is validated against: a typo fails at load, not at apply.
 * Every object is strict, so a misspelled key is refused by name rather than dropped for its default.
 */
import * as z from "zod"
import { nonBlank } from "../blank.ts"
import type { DatabaseConfig } from "./types.ts"
import { lockTimeoutMs } from "./core/pg-lock-timeout.ts"

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIG SCHEMA
   ═══════════════════════════════════════════════════════════════════════════ */

/** The empty database Atlas replays Postgres migrations on when a provider names none */
const DEFAULT_PG_DEV_URL = "docker://postgres/17/dev"

const NEON_IS_POSTGRES =
	"Neon and Supabase are postgres URLs: use the postgres provider type with the direct connection URL"

/* a connection string's content is checked when a command resolves its environment, so one unset in
   this shell blocks no other */
/* the Turso provider, apart so the union stays short to read */
const tursoProviderSchema = () =>
	z.strictObject({
		apiToken: z.string(),
		/* the provider names its database, as D1's does; an environment's name is a label */
		databaseName: nonBlank(
			undefined,
			"the turso provider names its database by databaseName: move the Turso database's name there (0.16 read it from the environment's name)",
		),
		group: nonBlank().default("default"),
		org: nonBlank(),
		type: z.literal("turso"),
	})

/* Built on use: defineConfig runs once per process, and module scope stays free of work */
const providerInputSchema = () =>
	z.discriminatedUnion("type", [
		tursoProviderSchema(),
		z.strictObject({
			authToken: z.string().optional(),
			type: z.literal("libsql"),
			url: z.string(),
		}),
		z.strictObject({
			path: nonBlank(),
			type: z.literal("bun-sqlite"),
		}),
		z.strictObject({
			devUrl: z.string().optional(),
			/* a literal of the config, so its grammar is held at load, as Postgres reads lock_timeout */
			lockTimeout: z
				.string()
				.superRefine((text, ctx) => {
					const ms = lockTimeoutMs(text)
					if (typeof ms === "string") ctx.addIssue({ code: "custom", message: ms })
				})
				.optional(),
			schema: nonBlank().optional(),
			type: z.literal("postgres"),
			/* checked when a command resolves its environment, so one unset in this shell blocks no other */
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
			databaseName: nonBlank(),
			local: z.boolean().optional(),
			type: z.literal("d1"),
			wranglerConfig: nonBlank().optional(),
			wranglerEnv: nonBlank().optional(),
		}),
	])

const environmentConfigInputSchema = () =>
	z.strictObject({
		name: nonBlank().optional(),
		provider: providerInputSchema().optional(),
	})

type DatabaseInput = {
	environments?: Record<string, { provider?: unknown }> | undefined
	name?: string | undefined
	provider?: unknown
}

/** Why a database is of neither shape, each at its path: one target's name and provider, or environments that each resolve a provider */
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
			codegen: nonBlank().optional(),
			drizzleConfigPath: nonBlank(
				"drizzleConfigPath is empty; remove it to use the project's drizzle.config.ts, or name the file",
			).optional(),
			environments: z
				.record(
					nonBlank("an environment needs a name: -e cannot choose one keyed by a blank string"),
					environmentConfigInputSchema(),
				)
				.optional(),
			migrationsDir: nonBlank(),
			name: nonBlank().optional(),
			provider: providerInputSchema().optional(),
		})
		.superRefine((db, ctx) => {
			for (const issue of shapeIssues(db)) ctx.addIssue({ code: "custom", ...issue })
		})
		/* one of the two shapes, which shapeIssues has just held it to */
		.transform((db) => db as DatabaseConfig)

/** What comb.migrate.config.ts declares */
type CombMigrateConfig = {
	/** each database comb migrates, by the name `comb migrate` takes; at least one */
	databases: Record<string, DatabaseConfig>
}

/* typed with the declared config, so the schema cannot drift from it */
const configInputSchema = (): z.ZodType<CombMigrateConfig> =>
	z.strictObject({
		databases: z
			.record(z.string(), databaseConfigInputSchema())
			.refine((databases) => Object.keys(databases).length > 0, { message: "databases declares no database" }),
	})

export { type CombMigrateConfig, configInputSchema, DEFAULT_PG_DEV_URL }
