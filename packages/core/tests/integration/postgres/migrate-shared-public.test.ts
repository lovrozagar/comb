/**
 * M78 of the 0.13.0 round, with the real Atlas: comb 0.12 recorded every schema's files in the
 * shared atlas_schema_revisions, which public keeps as its own. A revision there with no file of
 * public's is another schema's when the same version and hash sit in that schema's own history
 * (1.6 adopts them): public ignores it, says so, and keeps its own order, so a file of its own
 * older than another schema's row still applies, and a file older than its own latest is refused.
 * The shared rows are never deleted.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

let pub = ""
let app = ""
beforeEach(() => {
	pub = mkdtempSync(join(tmpdir(), "comb-pg-shared-public-"))
	app = mkdtempSync(join(tmpdir(), "comb-pg-shared-app-"))
})
afterEach(() => {
	for (const dir of [pub, app]) rmSync(dir, { force: true, recursive: true })
})

/** The directory `dir` holding `files`, hashed */
function migrations(dir: string, files: Record<string, string>): void {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	hashDir(run, dir)
}

/** What comb 0.12 did: Atlas applies `dir` to `schema`, its history in the shared atlas_schema_revisions */
function applyAs012(url: string, schema: string, dir: string): void {
	const target = `${url}${url.includes("?") ? "&" : "?"}search_path=${schema}`
	const args = [
		"migrate",
		"apply",
		"--url",
		target,
		"--dir",
		`file://${dir}`,
		"--revisions-schema",
		"atlas_schema_revisions",
	]
	const ran = spawnSync("atlas", args, { encoding: "utf8" })
	if (ran.status !== 0) throw new Error(`atlas migrate apply: ${ran.stderr}${ran.stdout}`)
}

/** comb's approval, never asking: the files here are safe */
const approve = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: false })

/** The options applyWithAtlas takes for `schema` of the database at `url`, from `dir`, collecting what it prints */
function command(url: string, schema: string, dir: string) {
	const out: string[] = []
	const target = { devUrl: "postgres://comb-no-dev.invalid/dev", lockTimeout: "5s", schema, url }
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

const shared = async (url: string) =>
	(
		await query<{ version: string }>(
			url,
			"SELECT version FROM atlas_schema_revisions.atlas_schema_revisions ORDER BY version",
		)
	).map((r) => r.version)

const IGNORED = "20260105000000 is schema app's, recorded in atlas_schema_revisions_app; public ignores it"

/** app's own history recording `dir`'s files as Atlas would, without comb's adoption checks */
function recordOwn(url: string, dir: string, version: string): void {
	const args = [
		"migrate",
		"set",
		version,
		"--url",
		`${url}${url.includes("?") ? "&" : "?"}search_path=app`,
		"--dir",
		`file://${dir}`,
	]
	const ran = spawnSync("atlas", [...args, "--revisions-schema", "atlas_schema_revisions_app"], { encoding: "utf8" })
	if (ran.status !== 0) throw new Error(`atlas migrate set: ${ran.stderr}${ran.stdout}`)
}

/** A dev database, where adopting app's 0.12 rows replays them (P2), and a target, each a scratch database of its own */
const withDevAndTarget = (body: (dev: string, url: string) => Promise<void>) =>
	withScratchDb((dev) => withScratchDb((url) => body(dev, url)))

/**
 * The report's database: 0.12 applied public's a and app's b, app's own history records b (adopted
 * by comb, or set by hand from `otherHash`, an edited b), and public added c
 */
async function reportCase(url: string, dev: string, otherHash = false): Promise<void> {
	await query(url, "CREATE SCHEMA app")
	migrations(pub, { "20260101000000_a.sql": 'CREATE TABLE "a" ("id" integer);\n' })
	applyAs012(url, "public", pub)
	migrations(app, { "20260105000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n' })
	applyAs012(url, "app", app)
	if (otherHash) {
		migrations(app, { "20260105000000_b.sql": 'CREATE TABLE "b" ("id" integer, "x" integer);\n' })
		recordOwn(url, app, "20260105000000")
	} else {
		const adopting = command(url, "app", app)
		await applyWithAtlas({ ...adopting, target: { ...adopting.target, devUrl: dev } })
	}
	migrations(pub, { "20260103000000_c.sql": 'CREATE TABLE "c" ("id" integer);\n' })
}

describe("migrate on Postgres: public's shared history beside another schema's 0.12 rows (M78)", () => {
	describe("with Atlas v1.3.0", () => {
		it("ignores app's row, naming it, so status lists c, check classifies it, and apply runs it", async () => {
			await withDevAndTarget(async (dev, url) => {
				await reportCase(url, dev)
				const status = command(url, "public", pub)
				expect(statusWithAtlas(status).pending).toEqual(["20260103000000_c.sql"])
				expect(status.out).toContain(IGNORED)
				expect(await applyWithAtlas({ ...command(url, "public", pub), checkOnly: true })).toEqual([
					"20260103000000_c.sql",
				])
				const apply = command(url, "public", pub)
				expect(await applyWithAtlas(apply)).toEqual(["20260103000000_c.sql"])
				expect(apply.out).toContain(IGNORED)
				expect(await query(url, "SELECT to_regclass('public.c') IS NOT NULL AS made")).toEqual([{ made: true }])
				expect(await shared(url)).toEqual(["20260101000000", "20260103000000", "20260105000000"])
			})
		}, 90_000)

		it("applies a later file of public's after c, and refuses one older than public's own latest", async () => {
			await withDevAndTarget(async (dev, url) => {
				await reportCase(url, dev)
				await applyWithAtlas(command(url, "public", pub))
				migrations(pub, { "20260110000000_d.sql": 'CREATE TABLE "d" ("id" integer);\n' })
				expect(await applyWithAtlas(command(url, "public", pub))).toEqual(["20260110000000_d.sql"])
				migrations(pub, { "20260102000000_late.sql": 'CREATE TABLE "late" ("id" integer);\n' })
				const late = "20260102000000_late.sql is older than a migration already applied; rename it to a newer version"
				expect(() => statusWithAtlas(command(url, "public", pub))).toThrow(late)
				await expect(applyWithAtlas(command(url, "public", pub))).rejects.toThrow(late)
				expect(await query(url, "SELECT to_regclass('public.late') IS NULL AS absent")).toEqual([{ absent: true }])
			})
		}, 90_000)

		it("refuses app's row as M76 does when app's own history records it with another hash", async () => {
			await withDevAndTarget(async (dev, url) => {
				await reportCase(url, dev, true)
				const gone = "20260105000000 was applied, and its file is gone or renamed"
				await expect(applyWithAtlas(command(url, "public", pub))).rejects.toThrow(gone)
				expect(await shared(url)).toEqual(["20260101000000", "20260105000000"])
			})
		}, 90_000)
	})
})
