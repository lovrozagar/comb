/* Runs once in the vitest main process, where output is not captured: says why the Postgres
 * suites skip locally, and fails the run at once in CI when the server URL is missing. */
import { PG_URL_VAR, pgUrl } from "./pg.ts"

export default function setup(): void {
	if (pgUrl() !== undefined) return
	process.stderr.write(
		`[comb] Postgres suites skipped: ${PG_URL_VAR} is unset (set it to a Postgres URL to run them)\n`,
	)
}
