/* Runs once in the vitest main process, where output is not captured: says why the Postgres,
 * Atlas and Docker cases skip locally, and fails the run at once in CI when one is missing. */
import { atlasAvailable, DOCKER_VAR, dockerDevWanted } from "./atlas.ts"
import { PG_URL_VAR, pgUrl } from "./pg.ts"

export default function setup(): void {
	if (!atlasAvailable()) {
		process.stderr.write("[comb] Atlas suites skipped: atlas is not on PATH (https://atlasgo.io)\n")
	}
	if (!dockerDevWanted()) {
		process.stderr.write(
			`[comb] the docker:// dev database case skipped: set ${DOCKER_VAR}=1 to run it (it starts containers)\n`,
		)
	}
	if (pgUrl() !== undefined) return
	process.stderr.write(
		`[comb] Postgres suites skipped: ${PG_URL_VAR} is unset (set it to a Postgres URL to run them)\n`,
	)
}
