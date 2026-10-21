import { describe, expect, it } from "vitest"
import { defineConfig } from "./config.ts"
import { configInputSchema, DEFAULT_PG_DEV_URL } from "./config-schema.ts"

/** A config whose one database is the D1 provider with `provider`'s fields */
const d1 = (provider: Record<string, unknown>) => () =>
	defineConfig({
		databases: {
			core: { migrationsDir: "./m", name: "core", provider: { databaseName: "core", type: "d1", ...provider } },
		},
	})

describe("migrate/config: the D1 provider (C2)", () => {
	it("takes a database by its name alone, as wrangler does", () => {
		expect(d1({})).not.toThrow()
	})

	it("refuses databaseId, which it never read, saying what names the database", () => {
		expect(d1({ databaseId: "abc123" })).toThrow(
			"databaseId is gone: wrangler finds the database by databaseName and the wrangler config's database_id",
		)
	})
})

describe("configInputSchema", () => {
	it("defaults Postgres's dev database to Atlas's docker URL, and refuses a neon provider", () => {
		expect(DEFAULT_PG_DEV_URL).toBe("docker://postgres/17/dev")
		const neon = { databases: { core: { migrationsDir: "./m", name: "core", provider: { type: "neon" } } } }
		expect(configInputSchema().safeParse(neon).success).toBe(false)
	})
})
