/**
 * P2 of r19: a devUrl comb refuses is refused before comb's own dev-schema create, so a refused diff
 * writes nothing, to the target least of all
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { beforeAll, describe, expect, it } from "vitest"
import type { PgTarget } from "../../../src/migrate/core/atlas-target.ts"
import { generateSchemaDiff } from "../../../src/migrate/core/atlas.ts"
import { generateIncrementalMigration } from "../../../src/migrate/core/migrate-diff.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

const POST = 'CREATE TABLE "post" ("id" integer PRIMARY KEY);\n'
const SAME = "url and devUrl are the same database; Atlas empties the dev database, so give it its own"

/** Whether `url`'s database has schema `name` */
async function hasSchema(url: string, name: string): Promise<boolean> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [name])).rowCount === 1
	} finally {
		await client.end()
	}
}

describe("migrate diff on Postgres: a devUrl that is the target", () => {
	it("refuses diff and the schema diff on a non-public schema, and the target never gets the schema", () =>
		withScratchDb(async (url) => {
			const same: PgTarget = { devUrl: url, lockTimeout: "5s", schema: "app", url }
			const dir = mkdtempSync(join(tmpdir(), "comb-p2-"))
			try {
				await expect(
					generateIncrementalMigration({
						dialect: "postgres",
						migrationName: "init",
						migrationsDir: dir,
						target: same,
						targetSchema: POST,
					}),
				).rejects.toThrow(SAME)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
			await expect(
				generateSchemaDiff({ dialect: "postgres", fromSchema: "", target: same, toSchema: POST }),
			).rejects.toThrow(SAME)
			expect(await hasSchema(url, "app")).toBe(false)
		}))
})
