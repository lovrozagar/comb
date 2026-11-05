/**
 * The docs the release's tarball carries are the ones a consumer is sent to: a doc the README or a
 * shipped src file names. A contributor doc (testing.md, on coverage exemptions) stays in the repo.
 * The tarball is bun pm pack's, as .github/scripts/pack-for-publish.sh packs it for both registries.
 */
import { spawnSync } from "node:child_process"
import { globSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { describe, expect, it } from "vitest"

const CORE = join(import.meta.dirname, "../..")
const ROOT = join(CORE, "../..")

/** The paths bun pm pack puts in the tarball, with no script run and nothing written */
function packed(): string[] {
	const run = spawnSync("bun", ["pm", "pack", "--dry-run", "--ignore-scripts"], { cwd: CORE, encoding: "utf8" })
	if (run.status !== 0) throw new Error(`bun pm pack exited ${run.status}\n${run.stderr}`)
	return [...`${run.stdout}${run.stderr}`.matchAll(/^packed \S+ (\S+)$/gm)].map(([, path]) => path!)
}

/** The text a consumer reads: the README and every shipped src file */
function shippedText(): string {
	const src = globSync("src/**/*.{ts,mjs}", { cwd: CORE }).filter((file) => !file.endsWith(".test.ts"))
	return [join(ROOT, "README.md"), ...src.map((file) => join(CORE, file))]
		.map((file) => readFileSync(file, "utf8"))
		.join("\n")
}

describe("the docs the tarball carries", () => {
	it("are the ones the README or a shipped src file names", () => {
		const docs = packed().filter((path) => path.startsWith("docs/"))
		const text = shippedText()
		expect(docs.length).toBeGreaterThan(0)
		expect(docs.filter((doc) => !text.includes(basename(doc)))).toEqual([])
	})
})
