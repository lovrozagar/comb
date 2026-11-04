/**
 * A checkout tests its own source: the `@lovrozagar/comb` a generated project beneath the checkout
 * resolves is this checkout's packages/core. Resolution walks up the project's node_modules
 * directories, and worktrees live under the main checkout's .worktrees/, so a worktree without its
 * own install resolves comb through the main checkout's node_modules, and a run there tests whichever
 * checkout that link points at (plan 21, 2026-11-04: the root link pointed at another worktree, and
 * three suites failed on its source). Resolving from packages/core itself proves nothing: the package
 * resolves its own name to itself.
 */
import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

const CORE = realpathSync(join(import.meta.dirname, "../.."))
const CHECKOUT = dirname(dirname(CORE))

/** The comb package a project in `dir` resolves: the nearest node_modules/@lovrozagar/comb up from it */
function combFrom(dir: string): string | undefined {
	const link = join(dir, "node_modules", "@lovrozagar", "comb")
	if (existsSync(link)) return realpathSync(link)
	return dirname(dir) === dir ? undefined : combFrom(dirname(dir))
}

describe("the install this checkout tests", () => {
	it("resolves @lovrozagar/comb, from the checkout's root, to this checkout's packages/core", () => {
		const resolved = combFrom(CHECKOUT)
		expect(resolved, `@lovrozagar/comb resolves to ${resolved}, not ${CORE}: run bun install in ${CHECKOUT}`).toBe(CORE)
	})
})
