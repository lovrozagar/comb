/* Runs once in the vitest main process, where output is not captured: fails the run at once when
 * Postgres or Atlas is missing, as their suites are required, and says why the docker:// case
 * skips locally. */
import { DOCKER_VAR, dockerDevWanted, requireAtlas } from "./atlas.ts"
import { pgUrl } from "./pg.ts"

export default function setup(): void {
	pgUrl()
	requireAtlas()
	if (!dockerDevWanted()) {
		process.stderr.write(
			`[comb] the docker:// dev database case skipped: set ${DOCKER_VAR}=1 to run it (it starts containers)\n`,
		)
	}
}
