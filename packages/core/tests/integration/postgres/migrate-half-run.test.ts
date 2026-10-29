/**
 * 27.6 of plan 15 (P11 of the 0.14.1 review), on real Atlas: a file Atlas ran halfway outside a
 * transaction, with a late file added before it. Atlas's status names the late file only in its
 * out-of-order error, never in what it lists, so comb names that file, not the unchanged half-run one.
 * The unit test's status is shaped as this run shows it; this case keeps the two from drifting apart.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-half-run-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** `files` written into the migrations directory, hashed */
function migrations(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	hashDir(run, dir)
}

/** Every file approved, as `--yes` approves a cautious one */
const approve = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true })

/** The options applyWithAtlas takes for the database at `url`, every file approved */
function command(url: string) {
	const out: string[] = []
	const target = { devUrl: "postgres://comb-no-dev.invalid/dev", lockTimeout: "5s", schema: "public", url }
	return { approve, dir, out, print: (line: string) => out.push(line), target }
}

/* its second statement fails, after its first ran and stayed */
const HALF = "-- atlas:txmode none\n\nCREATE TABLE h1 (id int);\nCREATE TABLE h1 (id int);\nCREATE TABLE h2 (id int);\n"

describe("a late file added before a file Atlas ran halfway, on Atlas v1.3.0", () => {
	it("is named as the late file, and the unchanged half-run file is not blamed", async () => {
		await withScratchDb(async (url) => {
			migrations({ "20260101000010_a.sql": "CREATE TABLE a (id int PRIMARY KEY);\n", "20260101000020_half.sql": HALF })
			await expect(applyWithAtlas(command(url))).rejects.toThrow("20260101000020_half.sql failed at")
			migrations({ "20260101000015_late.sql": "CREATE TABLE late (id int);\n" })
			const late = "20260101000015_late.sql is older than a migration already applied"
			expect(() => statusWithAtlas(command(url))).toThrow(late)
			await expect(applyWithAtlas(command(url))).rejects.toThrow(late)
		})
	}, 60_000)
})
