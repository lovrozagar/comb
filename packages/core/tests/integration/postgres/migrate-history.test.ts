/**
 * The Postgres history against the files with the real Atlas (M76): Atlas maps a revision to its
 * file by version and hashes each file over its name and the ones before it, so an applied file
 * renamed, gone or edited is named for what happened to it, in that order.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { withScratchDb } from "../support/pg.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-history-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The migrations directory holding `files`, hashed */
function migrations(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	hashDir(run, dir)
}

/** comb's approval, never asking: every file here is safe */
const approve = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: false })

/** The options applyWithAtlas takes for the database at `url`, collecting what it prints */
function command(url: string) {
	const out: string[] = []
	/* apply and status never use the dev database */
	const target = { devUrl: "postgres://comb-no-dev.invalid/dev", lockTimeout: "5s", schema: "public", url }
	return { approve, dir, out, print: (line: string) => out.push(line), target }
}

async function query<T>(url: string, sql: string): Promise<T[]> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows as T[]
	} finally {
		await client.end()
	}
}

describe("migrate status, check and apply on Postgres: an applied file gone, or renamed to another version", () => {
	describe("with Atlas v1.3.0", () => {
		/* M76: Atlas reports a revision whose file went, and hashes each file over the ones before it */
		it("refuses an applied file deleted or renamed since, naming its version, in check and apply (M76)", async () => {
			const seed = {
				"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
				"20260102000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n',
			}
			const cases: Array<[string, Record<string, string | null>, string]> = [
				["the last deleted", { "20260102000000_b.sql": null }, "20260102000000"],
				[
					"the last renamed",
					{ "20260102000000_b.sql": null, "20260103000000_b.sql": 'INSERT INTO "a" VALUES (3);\n' },
					"20260102000000",
				],
				["an earlier deleted", { "20260101000000_a.sql": null }, "20260101000000"],
			]
			for (const [, change, version] of cases) {
				await withScratchDb(async (url) => {
					rmSync(dir, { force: true, recursive: true })
					mkdirSync(dir)
					migrations(seed)
					await applyWithAtlas(command(url))
					for (const [name, sql] of Object.entries(change)) {
						if (sql === null) rmSync(join(dir, name))
						else writeFileSync(join(dir, name), sql)
					}
					hashDir(run, dir)
					const gone = `${version} was applied, and its file is gone or renamed`
					const status = command(url)
					statusWithAtlas(status)
					expect(status.out).toContain(gone)
					await expect(applyWithAtlas({ ...command(url), checkOnly: true })).rejects.toThrow(gone)
					await expect(applyWithAtlas(command(url))).rejects.toThrow(gone)
					expect(await query(url, 'SELECT * FROM "a"')).toEqual([])
				})
			}
		}, 120_000)
	})
})

describe("migrate status, check and apply on Postgres: an applied file renamed under its version, or edited", () => {
	describe("with Atlas v1.3.0", () => {
		/* ruling (a): Atlas hashes each file over its name and the ones before it, so a rename is refused by name */
		it("refuses a file renamed under its version by both names, the first of three too, in status, check and apply (M76)", async () => {
			const files = {
				"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
				"20260102000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n',
				"20260103000000_c.sql": 'CREATE TABLE "c" ("id" integer);\n',
			}
			for (const [from, to] of [
				["20260102000000_b.sql", "20260102000000_x.sql"],
				["20260101000000_a.sql", "20260101000000_x.sql"],
			] as const) {
				await withScratchDb(async (url) => {
					rmSync(dir, { force: true, recursive: true })
					mkdirSync(dir)
					migrations(files)
					await applyWithAtlas(command(url))
					rmSync(join(dir, from))
					migrations({ [to]: files[from] })
					const refusal = `${from.slice(0, 14)} was applied as ${from} and is now ${to}; restore its name`
					expect(() => statusWithAtlas(command(url))).toThrow(refusal)
					await expect(applyWithAtlas({ ...command(url), checkOnly: true })).rejects.toThrow(refusal)
					await expect(applyWithAtlas(command(url))).rejects.toThrow(refusal)
				})
			}
		}, 120_000)

		it("refuses an applied file named by its version alone that was edited since (M76)", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				migrations({ "20260101000000.sql": 'CREATE TABLE "a" ("id" integer, "tier" integer NOT NULL DEFAULT 0);\n' })
				const refusal = /^20260101000000\.sql was applied, then edited/
				expect(() => statusWithAtlas(command(url))).toThrow(refusal)
				await expect(applyWithAtlas({ ...command(url), checkOnly: true })).rejects.toThrow(refusal)
				await expect(applyWithAtlas(command(url))).rejects.toThrow(refusal)
			})
		}, 60_000)
	})
})
