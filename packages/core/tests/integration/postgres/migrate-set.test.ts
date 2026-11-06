/**
 * Leaf 16.3 (set) of plan 21, on real Atlas: `atlas migrate set <v>` records each file in name
 * order until the first whose version, compared as text, sorts above v
 * (.tmp/grunt/p21/areas/ae3/exo/probe6.log). 0.20.1 set the name-last file's version, so on
 * versions of mixed length it recorded fewer files than it printed, or none. Baseline and adoption
 * now record exactly the files they name, or refuse before any write.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { approveMigration } from "../../../src/migrate/core/approval.ts"
import { applyWithAtlas, baselineWithAtlas, statusWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import type { ParsedMigration } from "../../../src/migrate/migration-types.ts"
import { withScratchDb } from "../support/pg.ts"

/* baseline replays the history with Postgres's parser, which its caller loads */
beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-pg-set-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

/** `files` written into the migrations directory, hashed */
async function migrations(files: Record<string, string>): Promise<void> {
	for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql)
	await hashDir(run, dir)
}

/** comb's approval, never asking: the files here are safe */
const approve = (m: ParsedMigration) => approveMigration(m, { target: "core", yes: false })

/** The options the commands take for `schema` of the database at `url`, collecting what they print */
function command(url: string, devUrl: string, schema = "public") {
	const out: string[] = []
	const target = { devUrl, lockTimeout: "5s", schema, url }
	return { approve, dir, out, print: (line: string) => out.push(line), target }
}

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

/** The versions recorded in the revisions schema `schema` */
const recorded = async (url: string, schema: string) =>
	(
		await query<{ version: string }>(url, `SELECT version FROM ${schema}.atlas_schema_revisions ORDER BY 1`).catch(
			() => [],
		)
	).map((r) => r.version)

/** What comb 0.12 did: Atlas applies the directory to schema app, its history in the shared atlas_schema_revisions */
function applyAs012(url: string): void {
	const args = ["migrate", "apply", "--url", `${url}&search_path=app`, "--dir", `file://${dir}`]
	const ran = spawnSync("atlas", [...args, "--revisions-schema", "atlas_schema_revisions"], { encoding: "utf8" })
	if (ran.status !== 0) throw new Error(`atlas migrate apply: ${ran.stderr}${ran.stdout}`)
}

/** A dev database and a target, each a scratch database of its own */
const withDevAndTarget = (body: (dev: string, url: string) => Promise<void>) =>
	withScratchDb((dev) => withScratchDb((url) => body(dev, url)))

/* by name 20260101000000_b.sql sorts before 20260101_a.sql, while its version sorts above */
const B = { "20260101000000_b.sql": 'CREATE TABLE "b" ("id" integer);\n' }
const A = { "20260101_a.sql": 'CREATE TABLE "a" ("id" integer);\n' }
const C = { "20260102_c.sql": 'CREATE TABLE "c" ("id" integer);\n' }

describe("migrate baseline on Postgres, on versions of mixed length", () => {
	it("records every file it prints, so apply then has nothing to run", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await query(url, 'CREATE TABLE "a" ("id" integer); CREATE TABLE "b" ("id" integer)')
			await migrations({ ...B, ...A })
			const baseline = command(url, devUrl)
			expect(await baselineWithAtlas(baseline)).toEqual(["20260101000000_b.sql", "20260101_a.sql"])
			expect(baseline.out.filter((line) => line.startsWith("Marked applied"))).toEqual([
				"Marked applied: 20260101000000_b.sql",
				"Marked applied: 20260101_a.sql",
			])
			expect(await recorded(url, "atlas_schema_revisions")).toEqual(["20260101", "20260101000000"])
			expect(await applyWithAtlas(command(url, devUrl))).toEqual([])
			expect((await statusWithAtlas(command(url, devUrl))).pending).toEqual([])
		})
	}, 60_000)
})

describe("adopting 0.12's shared history on Postgres, on versions of mixed length", () => {
	it("records exactly what 0.12 ran, so apply runs the rest", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await query(url, "CREATE SCHEMA app")
			await migrations({ ...B, ...A })
			applyAs012(url)
			await migrations(C)
			expect(await applyWithAtlas(command(url, devUrl, "app"))).toEqual(["20260102_c.sql"])
			expect(await recorded(url, "atlas_schema_revisions_app")).toEqual(["20260101", "20260101000000", "20260102"])
		})
	}, 60_000)

	it("refuses, in status and before any write, a file after what 0.12 ran that Atlas would record with it", async () => {
		await withDevAndTarget(async (devUrl, url) => {
			await query(url, "CREATE SCHEMA app")
			await migrations(B)
			applyAs012(url)
			await migrations(A)
			const refusal =
				"20260101_a.sql sorts after the files 0.12 ran, yet its version sorts below 20260101000000_b.sql's, so atlas migrate set would record it with them"
			await expect(statusWithAtlas(command(url, devUrl, "app"))).rejects.toThrow(refusal)
			await expect(applyWithAtlas({ ...command(url, devUrl, "app"), checkOnly: true })).rejects.toThrow(refusal)
			await expect(applyWithAtlas(command(url, devUrl, "app"))).rejects.toThrow(refusal)
			await expect(baselineWithAtlas(command(url, devUrl, "app"))).rejects.toThrow(refusal)
			expect(await recorded(url, "atlas_schema_revisions_app")).toEqual([])
			expect(await query(url, "SELECT to_regclass('app.a') IS NULL AS absent")).toEqual([{ absent: true }])
		})
	}, 60_000)
})
