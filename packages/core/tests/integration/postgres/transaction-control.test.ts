/**
 * PA2 of r22b: a file Atlas runs in one transaction holds no BEGIN, COMMIT or ROLLBACK of its own.
 * Its COMMIT kept what ran before a later failure while comb said the file was rolled back, and in
 * check's replay it ended the counted transaction, so a role a later DO made stayed on devUrl's
 * server. comb refuses the file from the file alone, before check replays anything and before
 * apply runs it; a txmode none file keeps its own.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"
import { query, roleOf, testRoles } from "../support/pg-roles.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-transaction-control-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const UNSAFE = "-- comb:allow-unsafe: the test's history\n"
const REFUSAL = "Atlas runs this file in one transaction and records it there, so its own COMMIT ends that transaction"

/** The files, named in order and hashed */
async function write(files: readonly string[]): Promise<void> {
	files.forEach((sql, i) => writeFileSync(join(dir, `2026010${i + 1}000000_f${i}.sql`), sql))
	await hashDir(run, dir)
}

/** The options of a run against `url`, approving every file */
const options = (devUrl: string, url: string, checkOnly = false) => ({
	approve: (m: ParsedMigration) => approveMigration(m, { target: "core", yes: true }),
	checkOnly,
	dir,
	print: () => undefined,
	target: { devUrl, lockTimeout: "5s", schema: "public", url },
})

/** The tables `url`'s public schema holds, by name */
const tables = async (url: string): Promise<string[]> =>
	(await query(url, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map((row) =>
		String(row["tablename"]),
	)

describe("a transactional file holds no transaction control (PA2; sibling: PA13's inside-only statements)", () => {
	it("is refused at check before the replay runs a statement of it, so a later DO's role stays off devUrl's server", async () => {
		const [made] = testRoles("comb_t_commit")
		await write([
			"CREATE TABLE a (id int PRIMARY KEY);\n",
			`${UNSAFE}CREATE TABLE b (id int);\nCOMMIT;\nDO $$ BEGIN CREATE ROLE ${made}; END $$;\n`,
		])
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await expect(applyWithAtlas(options(dev, url, true))).rejects.toThrow(REFUSAL)
				expect(await roleOf(made)).toEqual([])
			}),
		)
	}, 60_000)

	it("is refused at apply before Atlas runs it, so nothing of it stays", async () => {
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await write(["CREATE TABLE a (id int PRIMARY KEY);\n"])
				await applyWithAtlas(options(dev, url))
				await write([
					"CREATE TABLE a (id int PRIMARY KEY);\n",
					"CREATE TABLE b (id int);\nCOMMIT;\nCREATE TABLE c (id int);\n",
				])
				await expect(applyWithAtlas(options(dev, url))).rejects.toThrow(REFUSAL)
				expect(await tables(url)).toEqual(["a"])
			}),
		)
	}, 60_000)

	it("leaves a txmode none file its own BEGIN and COMMIT, which apply runs", async () => {
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await write(["-- atlas:txmode none\n\nBEGIN;\nCREATE TABLE a (id int);\nCREATE TABLE b (id int);\nCOMMIT;\n"])
				expect(await applyWithAtlas(options(dev, url, true))).toHaveLength(1)
				expect(await applyWithAtlas(options(dev, url))).toHaveLength(1)
				expect(await tables(url)).toEqual(["a", "b"])
			}),
		)
	}, 60_000)
})
