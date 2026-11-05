/**
 * PA7 of r22b: comb migrates one schema, and Atlas keeps a URL's own search_path, so a devUrl that
 * names another schema diffed that schema on dev and called a new table of `schema` in sync. The
 * devUrl's search_path is held to the url's rule: it names `schema`, or comb refuses it by field name.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { PgTarget } from "../../../src/migrate/core/atlas-target.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { withScratchDb } from "../support/pg.ts"

/* a diff reads Postgres files with Postgres's parser, which its callers load (M75) */
beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-dev-scope-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** A drizzle schema holding the table app.t */
const APP_T = 'CREATE TABLE "app"."t" ("id" integer);\n'

/** The scratch dev database `dev`, given schema app and a devUrl whose search_path names `scope` */
async function scopedDev(dev: string, scope: string): Promise<PgTarget> {
	const client = new pg.Client({ connectionString: dev })
	await client.connect()
	try {
		await client.query("CREATE SCHEMA app")
	} finally {
		await client.end()
	}
	const devUrl = `${dev}${dev.includes("?") ? "&" : "?"}search_path=${scope}`
	return { devUrl, lockTimeout: "5s", schema: "app", url: "" }
}

/** One diff of APP_T into the migrations directory, on `target`'s dev database */
const diff = (target: PgTarget) =>
	generateIncrementalMigration({
		dialect: "postgres",
		migrationName: "one",
		migrationsDir: dir,
		target,
		targetSchema: APP_T,
	})

describe("migrate diff on Postgres: devUrl's search_path is checked against schema (PA7; sibling: url's rule)", () => {
	describe("with Atlas v1.3.0", () => {
		it("refuses a devUrl whose search_path names public with schema app, writing nothing", async () => {
			await withScratchDb(async (dev) => {
				await expect(diff(await scopedDev(dev, "public"))).rejects.toThrow(
					"the devUrl's search_path names public, but schema is app; comb migrates one: set schema to it, and drop search_path from the devUrl",
				)
				expect(readdirSync(dir).filter((file) => file.endsWith(".sql"))).toEqual([])
			})
		})

		it("diffs app.t into a file when the devUrl's search_path names app", async () => {
			await withScratchDb(async (dev) => {
				const out = await diff(await scopedDev(dev, "app"))
				expect({ files: out.files.length, synced: out.synced }).toEqual({ files: 1, synced: false })
			})
		})
	})
})
