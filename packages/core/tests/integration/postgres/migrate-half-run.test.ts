/**
 * 27.6 of plan 15 (P11 of the 0.14.1 review), on real Atlas: a file Atlas ran halfway outside a
 * transaction, with a late file added before it. Atlas's status names the late file only in its
 * out-of-order error, never in what it lists, so comb names that file, not the unchanged half-run one.
 * The unit test's status is shaped as this run shows it; this case keeps the two from drifting apart.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/migration-types.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-half-run-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** `files` written into the migrations directory, hashed */
async function migrations(files: Record<string, string>): Promise<void> {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	await hashDir(run, dir)
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
			await migrations({
				"20260101000010_a.sql": "CREATE TABLE a (id int PRIMARY KEY);\n",
				"20260101000020_half.sql": HALF,
			})
			await expect(applyWithAtlas(command(url))).rejects.toThrow("20260101000020_half.sql failed at")
			await migrations({ "20260101000015_late.sql": "CREATE TABLE late (id int);\n" })
			const late = "20260101000015_late.sql was never applied, yet it sorts before 20260101000020_half.sql, which was"
			await expect(statusWithAtlas(command(url))).rejects.toThrow(late)
			await expect(applyWithAtlas(command(url))).rejects.toThrow(late)
		})
	}, 60_000)
})

/* its INSERT fails until the table it fills exists, after its first statement ran and stayed */
const FIXABLE =
	"-- atlas:txmode none\n\nCREATE TABLE h1 (id int);\n\nINSERT INTO missing VALUES (1);\n\nCREATE TABLE h2 (id int);\n"

/*
 * leaf 16.3 (a) of plan 21: the name is the only order, and Atlas resumes a file it ran halfway outside a
 * transaction only while its version is the highest recorded; below another, it runs the next file
 * instead and reports nothing pending (.tmp/grunt/p21/areas/ae3/exo/probe4.log)
 */
describe("a txmode none file among versions of mixed length, on Atlas v1.3.0", () => {
	it("stops at its failed statement, then resumes there and runs the file after it, its version the highest", async () => {
		await withScratchDb(async (url) => {
			await migrations({
				"20260101000000_b.sql": "CREATE TABLE b (id int);\n",
				"20260101_a.sql": "CREATE TABLE a (id int);\n",
				"20260102_half.sql": FIXABLE,
				"20260103_c.sql": "CREATE TABLE c (id int);\n",
			})
			await expect(applyWithAtlas(command(url))).rejects.toThrow("20260102_half.sql failed at")
			expect(await tables(url)).toEqual(["a", "b", "h1"])
			await query(url, "CREATE TABLE missing (id int)")
			expect(await applyWithAtlas(command(url))).toEqual(["20260102_half.sql", "20260103_c.sql"])
			expect(await tables(url)).toEqual(["a", "b", "c", "h1", "h2", "missing"])
			expect((await statusWithAtlas(command(url))).pending).toEqual([])
		})
	}, 60_000)

	it("is refused before any write while its version sorts below one that runs before it", async () => {
		await withScratchDb(async (url) => {
			await migrations({
				"20260101000000_b.sql": "CREATE TABLE b (id int);\n",
				"20260101_half.sql": FIXABLE,
				"20260102_c.sql": "CREATE TABLE c (id int);\n",
			})
			const refusal =
				"20260101_half.sql runs outside a transaction (atlas:txmode none), yet its version sorts below 20260101000000_b.sql's, which runs before it"
			await expect(applyWithAtlas({ ...command(url), checkOnly: true })).rejects.toThrow(refusal)
			await expect(applyWithAtlas(command(url))).rejects.toThrow(refusal)
			expect(await tables(url)).toEqual([])
		})
	}, 60_000)
})

/** Runs `sql` on the database at `url`, returning its rows */
async function query<T>(url: string, sql: string): Promise<T[]> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows as T[]
	} finally {
		await client.end()
	}
}

/** The public tables of the database at `url` */
const tables = async (url: string): Promise<string[]> =>
	(
		await query<{ tablename: string }>(url, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
	).map((row) => row.tablename)
