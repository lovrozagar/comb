/**
 * A real Postgres server for the Postgres suites, at `COMB_TEST_PG_URL`. comb's Postgres
 * defects live in driver error shapes, so these run on node-postgres and postgres.js against a
 * server, not an emulator. CI must set the URL; locally the suites skip and say why.
 *
 * Every test gets its own sessions, and every table a test makes is TEMP, so tests never see
 * each other's tables and nothing outlives the session.
 */
import pg from "pg"
import postgres from "postgres"
import { afterEach, beforeEach, describe } from "vitest"

export const PG_URL_VAR = "COMB_TEST_PG_URL"

/** The server URL, or undefined locally when it is unset; under CI an unset URL is an error. */
export function pgUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const url = env[PG_URL_VAR]
	if (url !== undefined && url !== "") return url
	if (env.CI !== undefined && env.CI !== "")
		throw new Error(`${PG_URL_VAR} must be set in CI: the Postgres suites are required`)
	return undefined
}

/** `describe` when a server is configured, else a skipped suite; global-setup.ts prints why. */
export function describePg(name: string, suite: () => void): void {
	const unset = pgUrl() === undefined
	describe.skipIf(unset)(unset ? `${name} (${PG_URL_VAR} unset)` : name, suite)
}

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
