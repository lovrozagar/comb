/**
 * A real Postgres server for the Postgres suites, at `COMB_TEST_PG_URL`. comb's Postgres
 * defects live in driver error shapes, so these run on node-postgres and postgres.js against a
 * server, not an emulator. The suites are required, locally as in CI: an unset URL fails the run.
 *
 * Every test gets its own sessions, and every table a test makes is TEMP, so tests never see
 * each other's tables and nothing outlives the session.
 */
import pg from "pg"
import postgres from "postgres"
import { afterEach, beforeEach, onTestFinished } from "vitest"
import { getCurrentTest } from "vitest/suite"
import { scratchName } from "./scratch-sweep.ts"
import { pgUrl } from "../../support/pg-url.ts"

/* the URL is runner-free, for bun:test's suites too; the Postgres suites take it here with the rest */
export { PG_URL_VAR, pgUrl } from "../../support/pg-url.ts"

export type PgSessions = {
	/** node-postgres, one connection */
	pg(): pg.Client
	/** postgres.js, one connection */
	sql(): postgres.Sql
}

function need<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("usePg sessions exist only inside a test")
	return value
}

/** Fresh node-postgres and postgres.js sessions per test, ended after it (TEMP tables go with them). */
export function usePg(): PgSessions {
	let client: pg.Client | undefined
	let sql: postgres.Sql | undefined
	beforeEach(async () => {
		const url = pgUrl() as string
		client = new pg.Client({ connectionString: url })
		await client.connect()
		sql = postgres(url, { max: 1, onnotice: () => undefined })
	})
	afterEach(async () => {
		await Promise.all([client?.end(), sql?.end()])
		client = undefined
		sql = undefined
	})
	return { pg: () => need(client), sql: () => need(sql) }
}

/**
 * A database made for `run` on the server and dropped after it, for tools such as Atlas that
 * need a whole clean database rather than TEMP tables. `run` gets its URL. Called in a test, the
 * database is also dropped when the test ends, so one vitest timed out, whose `run` never settles,
 * leaves none (plan 21 leaf 10.9); a database a killed run left is the global setup's sweep's
 * (scratch-sweep.ts). The name carries the millisecond it was made, which the sweep reads. `options`
 * follow CREATE DATABASE, such as a template and locale.
 */
export async function withScratchDb<T>(run: (url: string) => Promise<T> | T, options?: string): Promise<T> {
	const server = new URL(pgUrl() as string)
	const name = scratchName()
	const admin = new pg.Client({ connectionString: server.href })
	let made = false
	let released: Promise<void> | undefined
	/* once, whichever comes first: `run` settling, or the test ending */
	const drop = async () => {
		if (made) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
	}
	const release = () => (released ??= drop().finally(() => admin.end()))
	if (getCurrentTest() !== undefined) onTestFinished(release)
	try {
		await admin.connect()
		await admin.query(`CREATE DATABASE ${name}${options === undefined ? "" : ` ${options}`}`)
		made = true
	} catch (error) {
		await release()
		throw error
	}
	const url = new URL(server.href)
	url.pathname = `/${name}`
	try {
		return await run(url.href)
	} finally {
		await release()
	}
}
