import { availableParallelism } from "node:os"

/**
 * The vitest workers a run may use: half the machine's cores off CI, at least one, so a local run leaves the
 * machine usable; on CI the runner is the job's alone, and vitest's own default stands
 */
export function workers(env: Record<string, string | undefined>, cores: number): number | undefined {
	return env.CI === "true" ? undefined : Math.max(1, Math.floor(cores / 2))
}

/** This run's cap, which every vitest config sets (tests/structure/workflows.test.ts holds it) */
export const MAX_WORKERS = workers(process.env, availableParallelism())
