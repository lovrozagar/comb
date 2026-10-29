/**
 * Plan 15's 21 (P12, P15 of the 0.14.1 review): a target schema other than public. Atlas is scoped
 * to the schema on both URLs and inspects it before anything runs, so no migration can create it:
 * comb explains a target without it, and creates it on the scratch dev database itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

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
