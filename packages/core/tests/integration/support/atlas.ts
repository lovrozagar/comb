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
