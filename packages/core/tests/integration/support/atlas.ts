/**
 * The Atlas CLI for the migration suites: comb's Atlas defects only show on the real binary,
 * so these run it. The suites are required, locally as in CI: a missing binary fails the run.
 */
import { spawnSync } from "node:child_process"

const runs = () => spawnSync("atlas", ["version"]).status === 0

/** Fails when `atlas` does not run, since a skipped suite would pass the gates. */
export function requireAtlas(probe: () => boolean = runs): void {
	if (!probe()) throw new Error("atlas is not on PATH: the Atlas suites are required (https://atlasgo.io)")
}

export const DOCKER_VAR = "COMB_TEST_DOCKER"

const dockerRuns = () => spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0

/**
 * Whether the docker://postgres/17/dev case runs. Atlas starts a short-lived container for it, and
 * each start changes the host's network under other sessions' browsers, so locally it runs only
 * with COMB_TEST_DOCKER=1; in CI it runs, and Docker must work.
 */
export function dockerDevWanted(env: NodeJS.ProcessEnv = process.env, probe: () => boolean = dockerRuns): boolean {
	const ci = env.CI !== undefined && env.CI !== ""
	if (!ci && env[DOCKER_VAR] !== "1") return false
	if (probe()) return true
	if (ci) throw new Error("docker must run in CI: the docker:// dev database case is required")
	return false
}
