/**
 * P3, P4 and 18.3 of plan 15: comb reaches the database libpq and Atlas read from a URL, whatever
 * libpq spelling names it. postgres.js reads none of libpq's query keys and sends each one it does
 * not know to the server as a setting, so a `?port=` reached another server, and a `?dbname=` or an
 * `sslrootcert` failed as an unknown setting, where Atlas took each.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { baselineWithAtlas } from "../../../src/migrate/core/atlas-apply.ts"
import { hashDir } from "../../../src/migrate/core/atlas-dir.ts"
import { readyDevSchema } from "../../../src/migrate/core/pg-dev-schema.ts"
import { readLiveObjects } from "../../../src/migrate/core/pg-live-objects.ts"
import { loadPostgresParser } from "../../../src/migrate/core/pg-parser.ts"
import { run } from "../../../src/migrate/core/process.ts"
import { withScratchDb } from "../support/pg.ts"

beforeAll(loadPostgresParser)

let dir = ""
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "comb-libpq-url-"))
})
afterEach(() => rmSync(dir, { force: true, recursive: true }))

const FUNCTION = "CREATE FUNCTION f() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;\n"

/** Run `sql` on the database at `url` */
async function exec(url: string, sql: string): Promise<unknown[]> {
	const client = new pg.Client({ connectionString: url })
	await client.connect()
	try {
		return (await client.query(sql)).rows
	} finally {
		await client.end()
	}
}

/** `url` respelled with its port, then its database, in libpq's query, and with a TLS key sslmode=disable never reads */
function spellings(url: string): Record<string, string> {
	const at = new URL(url)
	const userinfo = `${at.username}:${at.password}@`
	const database = at.pathname.slice(1)
	return {
		dbname: `postgres://${userinfo}${at.host}/?dbname=${database}&sslmode=disable`,
		port: `postgres://${userinfo}${at.hostname}/${database}?port=${at.port}&sslmode=disable`,
		sslrootcert: `postgres://${userinfo}${at.host}/${database}?sslmode=disable&sslrootcert=/nonexistent.pem`,
	}
}

describe("comb on a URL in each libpq spelling, as Atlas reads it", () => {
	it("reads the live functions of the database each spelling names", async () => {
		await withScratchDb(async (url) => {
			await exec(url, FUNCTION)
			for (const [name, spelled] of Object.entries(spellings(url))) {
				const live = await readLiveObjects({ schema: "public", url: spelled })
				expect([...live.routines.keys()], name).toEqual(["f"])
			}
		})
	})

	it("creates the target schema on the dev database each spelling names (18.3)", async () => {
		await withScratchDb(async (url) => {
			for (const [name, spelled] of Object.entries(spellings(url))) {
				await readyDevSchema({ devUrl: spelled, lockTimeout: "5s", schema: `app_${name}`, url: "" })
				const rows = await exec(url, `SELECT 1 FROM pg_namespace WHERE nspname = 'app_${name}'`)
				expect(rows, name).toHaveLength(1)
			}
		})
	})

	it("baselines a database through a ?port= target and dev URL, Atlas and comb reading one server", async () => {
		await withScratchDb((dev) =>
			withScratchDb(async (url) => {
				await exec(url, FUNCTION)
				writeFileSync(join(dir, "20260101000000_init.sql"), FUNCTION)
				hashDir(run, dir)
				const out: string[] = []
				const target = { devUrl: spellings(dev).port, lockTimeout: "5s", schema: "public", url: spellings(url).port }
				await baselineWithAtlas({ dir, print: (line: string) => out.push(line), target })
				expect(out).toContain("Marked applied: 20260101000000_init.sql")
			}),
		)
	}, 60_000)
})
