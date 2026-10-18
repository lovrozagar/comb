/**
 * The Atlas CLI for the migration suites: comb's Atlas defects only show on the real binary,
 * so these run it. CI installs it and must have it; locally the suites skip and say why.
 */
import { spawnSync } from "node:child_process"
import { describe } from "vitest"

const runs = () => spawnSync("atlas", ["version"]).status === 0

/** Whether `atlas` runs; under CI a missing binary is an error. */
export function atlasAvailable(env: NodeJS.ProcessEnv = process.env, probe: () => boolean = runs): boolean {
	if (probe()) return true
	if (env.CI !== undefined && env.CI !== "") {
		throw new Error("atlas must be on PATH in CI: the Atlas suites are required")
	}
	return false
}

/** `describe` when Atlas is installed, else a skipped suite; global-setup.ts prints why. */
export function describeAtlas(name: string, suite: () => void): void {
	const missing = !atlasAvailable()
	describe.skipIf(missing)(missing ? `${name} (atlas not installed)` : name, suite)
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
