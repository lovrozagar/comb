/**
 * The Postgres test server's URL, for every runner: vitest's suites (through tests/integration/
 * support/pg.ts), bun:test's, which cannot load that module's vitest hooks, and the consumer and e2e
 * cells. Every test file takes the URL here and none reads the variable itself
 * (tests/structure/pg-projects.test.ts), so an unset or empty URL fails a suite on its cause, never
 * later on whatever an empty URL breaks.
 */
export const PG_URL_VAR = "COMB_TEST_PG_URL"

/** The server URL; unset or empty, the run fails, since a skipped suite would pass the gates. */
export function pgUrl(env: NodeJS.ProcessEnv = process.env): string {
	const url = env[PG_URL_VAR]
	if (url !== undefined && url !== "") return url
	throw new Error(
		`${PG_URL_VAR} is unset: the Postgres suites are required. Set it to a Postgres server URL (docs/testing.md)`,
	)
}
