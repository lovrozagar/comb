/**
 * Plan 21 leaf 10.9: a test run leaves no scratch database behind. withScratchDb drops its database
 * when its test ends, a test vitest timed out too, and the Postgres projects' global setup sweeps,
 * once it holds the run's lock, every comb_scratch_* database a killed run left: one this role owns,
 * with no session on it, made over an hour ago. Any other is kept, and said why. Sibling: P4's sweep
 * of what a replay left (replay-sweep.test.ts).
 */
import pg from "pg"
import { afterAll, beforeEach, afterEach, describe, expect, it } from "vitest"
import { pgUrl, withScratchDb } from "../support/pg.ts"
import { SCRATCH_STALE_MS, scratchName, sweepScratchDbs } from "../support/scratch-sweep.ts"

let admin: pg.Client
beforeEach(async () => {
	admin = new pg.Client({ connectionString: pgUrl() })
	await admin.connect()
})
afterEach(() => admin.end())

/** Whether the server holds a database named `name` */
async function exists(name: string): Promise<boolean> {
	const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])
	return rows.length === 1
}

/* every database a test plants, dropped after the file whatever the test did */
const planted: string[] = []
afterAll(async () => {
	const client = new pg.Client({ connectionString: pgUrl() })
	await client.connect()
	try {
		for (const name of planted) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
	} finally {
		await client.end()
	}
})

/** A scratch database made as made `ageMs` ago, by its name's stamp */
async function plant(ageMs: number): Promise<string> {
	const name = scratchName(Date.now() - ageMs)
	planted.push(name)
	await admin.query(`CREATE DATABASE ${name}`)
	return name
}

describe("a test run leaves no scratch database behind (sibling: P4's stale-replay sweep)", () => {
	it("drops a stale scratch database, and keeps a fresh one and one a session is on, saying why", async () => {
		const stale = await plant(SCRATCH_STALE_MS + 60_000)
		const fresh = await plant(60_000)
		const connected = await plant(SCRATCH_STALE_MS + 60_000)
		const url = new URL(pgUrl())
		url.pathname = `/${connected}`
		const session = new pg.Client({ connectionString: url.href })
		await session.connect()
		try {
			const lines: string[] = []
			const swept = await sweepScratchDbs(admin, { log: (line) => lines.push(line) })
			expect(swept.dropped).toContain(stale)
			expect(swept.dropped).not.toContain(fresh)
			expect(swept.dropped).not.toContain(connected)
			expect(await exists(stale)).toBe(false)
			expect(await exists(fresh)).toBe(true)
			expect(await exists(connected)).toBe(true)
			expect(lines).toContainEqual(expect.stringMatching(new RegExp(`${fresh}.*under an hour old`)))
			expect(lines).toContainEqual(expect.stringMatching(new RegExp(`${connected}.*a session is on it`)))
		} finally {
			await session.end()
		}
	})

	describe("withScratchDb drops its database when vitest times its test out", () => {
		let name = ""
		it.fails("holds a scratch database past the test's bound", { timeout: 1500 }, () =>
			withScratchDb(async (url) => {
				name = new URL(url).pathname.slice(1)
				planted.push(name)
				expect(await exists(name)).toBe(true)
				await new Promise(() => undefined)
			}),
		)

		it("leaves nothing of it once the timed-out test has ended", async () => {
			expect(name).toMatch(/^comb_scratch_/)
			expect(await exists(name)).toBe(false)
		})
	})
})
