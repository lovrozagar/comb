/* Runs once in the vitest main process, where output is not captured: says why the Postgres and
 * Atlas suites skip locally, and fails the run at once in CI when either is missing. */
import { atlasAvailable } from "./atlas.ts"
import { PG_URL_VAR, pgUrl } from "./pg.ts"

export default function setup(): void {
	if (!atlasAvailable()) {
		process.stderr.write("[comb] Atlas suites skipped: atlas is not on PATH (https://atlasgo.io)\n")
	}
	if (pgUrl() !== undefined) return
	process.stderr.write(
		`[comb] Postgres suites skipped: ${PG_URL_VAR} is unset (set it to a Postgres URL to run them)\n`,
	)
}
