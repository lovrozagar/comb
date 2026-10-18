/**
 * `migrate apply`, `baseline` and `status` on Postgres with the real Atlas: each case writes a
 * migrations directory, applies it to a scratch database through applyWithAtlas, and reads the
 * result back from the database.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeEach, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/types.ts"
import { describeAtlas } from "../support/atlas.ts"
import { describePg, withScratchDb } from "../support/pg.ts"

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-apply-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** The migrations directory holding `files`, hashed */
function migrations(files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	hashDir(run, dir)
}

/** The options applyWithAtlas takes for the database at `url`, collecting what it prints */
function command(
	url: string,
	more: { approve?: (m: ParsedMigration) => ReturnType<typeof approveMigration>; lockTimeout?: string } = {},
) {
	const out: string[] = []
	const target = { devUrl: "docker://postgres/17/dev", lockTimeout: more.lockTimeout ?? "5s", schema: "public", url }
	const approve = more.approve ?? ((m: ParsedMigration) => approveMigration(m, { target: "core", yes: false }))
	/* no exec: applyWithAtlas runs the real atlas by default */
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

const tables = async (url: string) =>
	(
		await query<{ tablename: string }>(url, "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
	).map((r) => r.tablename)
const revisions = async (url: string) =>
	(
		await query<{ version: string }>(
			url,
			"SELECT version FROM atlas_schema_revisions.atlas_schema_revisions ORDER BY 1",
		)
	).map((r) => r.version)

/** An approval that, while it is asked, rewrites the file it approves and rehashes the directory */
async function editWhileAsking(m: ParsedMigration) {
	writeFileSync(join(dir, m.filename), 'CREATE TABLE "swapped" ("id" integer);\n')
	hashDir(run, dir)
	return approveMigration(m, { target: "core", yes: false })
}

describePg("migrate apply on Postgres", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("applies, keeps the history out of public, and applies nothing the second time", async () => {
			await withScratchDb(async (url) => {
				migrations({
					"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
					"20260102000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n',
				})
				expect(await applyWithAtlas(command(url))).toEqual(["20260101000000_a.sql", "20260102000000_b.sql"])
				expect(await tables(url)).toEqual(["a", "b"])
				expect(await revisions(url)).toEqual(["20260101000000", "20260102000000"])
				const again = command(url)
				expect(await applyWithAtlas(again)).toEqual([])
				expect(again.out).toEqual(["No migrations to apply"])
			})
		}, 60_000)

		it("refuses an unsafe file without approval, and applies it with the file's own approval", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				migrations({ "20260102000000_drop.sql": 'DROP TABLE "a";\n' })
				await expect(applyWithAtlas(command(url))).rejects.toThrow("20260102000000_drop.sql is unsafe")
				expect(await tables(url)).toEqual(["a"])
				migrations({ "20260102000000_drop.sql": '-- comb:allow-unsafe: a is retired\nDROP TABLE "a";\n' })
				const approved = command(url)
				await applyWithAtlas(approved)
				expect(approved.out).toContain("Approved in 20260102000000_drop.sql: a is retired")
				expect(await tables(url)).toEqual([])
			})
		}, 60_000)

		it("rolls back a failing file and keeps the ones before it", async () => {
			await withScratchDb(async (url) => {
				migrations({
					"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
					"20260102000000_bad.sql": 'CREATE TABLE "b" ("id" integer);\nALTER TABLE "nope" ADD COLUMN "x" integer;\n',
				})
				await expect(applyWithAtlas(command(url))).rejects.toThrow(
					'20260102000000_bad.sql failed at ALTER TABLE "nope" ADD COLUMN "x" integer;: pq: relation "nope" does not exist (42P01). It was rolled back',
				)
				expect(await tables(url)).toEqual(["a"])
				expect(await revisions(url)).toEqual(["20260101000000"])
			})
		}, 60_000)
	})
})

describePg("migrate apply on Postgres: history it refuses", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("refuses a file added before one already applied", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260102000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				migrations({ "20260101000000_late.sql": 'CREATE TABLE "late" ("id" integer);\n' })
				await expect(applyWithAtlas(command(url))).rejects.toThrow(
					"20260101000000_late.sql is older than a migration already applied; rename it to a newer version and run atlas migrate hash",
				)
				expect(await tables(url)).toEqual(["b"])
			})
		}, 60_000)

		it("applies what it classified, not an edit made while it was asking", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url, { approve: editWhileAsking }))
				expect(await tables(url)).toEqual(["a"])
			})
		}, 60_000)
	})
})

describePg("migrate apply on Postgres: locks", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("fails an ALTER that waits behind a reader after lockTimeout, instead of queueing every query", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				const reader = new pg.Client({ connectionString: url })
				await reader.connect()
				try {
					await reader.query('BEGIN; SELECT * FROM "a"')
					migrations({ "20260102000000_alter.sql": 'ALTER TABLE "a" ADD COLUMN "x" integer;\n' })
					const started = Date.now()
					await expect(applyWithAtlas(command(url, { lockTimeout: "1s" }))).rejects.toThrow("lock timeout")
					expect(Date.now() - started).toBeLessThan(15_000)
				} finally {
					await reader.query("ROLLBACK")
					await reader.end()
				}
			})
		}, 60_000)

		it("says another apply is running when Atlas cannot take its lock", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				const other = new pg.Client({ connectionString: url })
				await other.connect()
				try {
					/* the session lock Atlas takes while it applies (pg_locks objid 2686470616) */
					await other.query("SELECT pg_advisory_lock(2686470616)")
					await expect(applyWithAtlas(command(url))).rejects.toThrow(
						"another migrate apply is running on this database",
					)
				} finally {
					await other.end()
				}
			})
		}, 60_000)
	})
})

describePg("migrate baseline and status on Postgres", () => {
	describeAtlas("with Atlas v1.3.0", () => {
		it("records the history of a database set up by hand, runs none of it, and then has nothing to apply", async () => {
			await withScratchDb(async (url) => {
				await query(url, 'CREATE TABLE "a" ("id" integer)')
				migrations({
					"20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n',
					"20260102000000_b.sql": "SELECT 1;\n",
				})
				const baseline = command(url)
				expect(baselineWithAtlas(baseline)).toEqual(["20260101000000_a.sql", "20260102000000_b.sql"])
				expect(await revisions(url)).toEqual(["20260101000000", "20260102000000"])
				expect(await applyWithAtlas(command(url))).toEqual([])
				expect(() => baselineWithAtlas(command(url))).toThrow("the database already records 2 migrations")
				const status = command(url)
				statusWithAtlas(status)
				expect(status.out).toEqual(["Applied: 2 (up to 20260102000000)", "Pending: none"])
			})
		}, 60_000)

		it("warns of an applied file that was edited and rehashed since", async () => {
			await withScratchDb(async (url) => {
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
				await applyWithAtlas(command(url))
				migrations({ "20260101000000_a.sql": 'CREATE TABLE "a" ("id" bigint);\n' })
				const status = command(url)
				statusWithAtlas(status)
				expect(status.out.at(-1)).toBe(
					"Changed after it was applied: 20260101000000_a.sql; Atlas will not run it again, so the database may not match it",
				)
			})
		}, 60_000)
	})
})

it("keeps the scratch directory per test", () => {
	expect(dir).toContain("comb-pg-apply-")
})
