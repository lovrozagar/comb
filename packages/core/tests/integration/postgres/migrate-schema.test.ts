/**
 * Plan 15's 21 (P12, P15 of the 0.14.1 review): a target schema other than public. Atlas is scoped
 * to the schema on both URLs and inspects it before anything runs, so no migration can create it:
 * comb explains a target without it, and creates it on the scratch dev database itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import type { LiveRead } from "../../../src/migrate/core/pg-live-types.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

/* a diff and a baseline read Postgres files with Postgres's parser, which their callers load (M75) */
beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-schema-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The migrations directory holding `files`, atlas.sum written */
function migrations(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	hashDir(run, dir)
}

/** comb's approval, never asking: the files here are safe */
const approve = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: false })

/** applyWithAtlas's options for schema app of the database at `url` */
const command = (url: string, devUrl: string) => ({
	approve,
	dir,
	out: [] as string[],
	print: () => undefined,
	target: { devUrl, lockTimeout: "5s", schema: "app", url },
})

describe("migrate on Postgres: a target schema that does not exist yet (P15)", () => {
	describe("with Atlas v1.3.0", () => {
		it("explains the one CREATE SCHEMA the target needs before its first apply", async () => {
			await withScratchDb(async (devUrl) => {
				await withScratchDb(async (url) => {
					migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
					await expect(applyWithAtlas(command(url, devUrl))).rejects.toThrow(
						"schema app does not exist on the target; create it once (CREATE SCHEMA app) before the first apply",
					)
				})
			})
		}, 60_000)
	})
})

async function query(url: string, sql: string): Promise<Array<Record<string, unknown>>> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows
	} finally {
		await client.end()
	}
}

const USERS = 'CREATE TABLE "users" ("id" integer PRIMARY KEY);\n'

/** A database with no function, procedure or trigger: the baseline here compares its tables */
const noObjects: LiveRead = async () => ({
	policies: new Map(),
	relations: new Map(),
	routines: new Map(),
	triggers: new Map(),
})

/* P12 of the 0.14.1 review: Atlas inspects the schema its dev URL is scoped to before it replays anything */
describe("migrate on Postgres: schema app on an empty dev database (P12)", () => {
	describe("with Atlas v1.3.0", () => {
		it("diffs, creating the schema on the dev database", async () => {
			await withScratchDb(async (devUrl) => {
				migrations({ "20260101000000_users.sql": USERS })
				const diffed = await generateIncrementalMigration({
					dialect: "postgres",
					migrationName: "posts",
					migrationsDir: dir,
					target: { devUrl, lockTimeout: "5s", schema: "app", url: "" },
					targetSchema: `${USERS}CREATE TABLE "posts" ("id" integer);\n`,
				})
				expect(diffed.files).toHaveLength(1)
				expect(await query(devUrl, "SELECT nspname FROM pg_namespace WHERE nspname = 'app'")).toEqual([
					{ nspname: "app" },
				])
			})
		}, 60_000)

		it("baselines a target that holds the history's tables", async () => {
			await withScratchDb(async (devUrl) => {
				await withScratchDb(async (url) => {
					await query(url, `CREATE SCHEMA app; SET search_path = app; ${USERS}`)
					migrations({ "20260101000000_users.sql": USERS })
					const baseline = { ...command(url, devUrl), readLive: noObjects }
					expect(await baselineWithAtlas(baseline)).toEqual(["20260101000000_users.sql"])
				})
			})
		}, 60_000)
	})
})
