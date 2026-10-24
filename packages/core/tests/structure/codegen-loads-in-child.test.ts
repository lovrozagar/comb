/**
 * Codegen runs a consumer's tables module in its own child process alone (src/codegen/runtime):
 * every dynamic `import()` in src/codegen is the runtime reader's, which load.ts runs in a child
 * with PATH, HOME and NODE_OPTIONS only; the parent never loads a consumer module, and nothing
 * `require`s one.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const CODEGEN = join(import.meta.dirname, "../../src/codegen")

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : sources(full)
		return /\.m?[jt]s$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [full] : []
	})
}

/* a call that loads a module at run time: require, createRequire, or import() of a non-literal path */
const LOADS = [/\b(?:createRequire|require)\s*\(/, /\bimport\s*\(\s*(?!["'][^"']+["']\s*\))/]

describe("codegen loads a consumer's module only in its child", () => {
	it("holds no require, and its non-literal import()s are the child's", () => {
		const found: string[] = []
		for (const file of sources(CODEGEN)) {
			for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
				/* a comment loads nothing */
				if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) continue
				if (LOADS.some((pattern) => pattern.test(line))) found.push(`${file.slice(CODEGEN.length + 1)}:${index + 1}`)
			}
		}
		/* the reader's own, and the child's script in load.ts, which only the child runs */
		expect(found.every((at) => /^runtime\/(?:child|load)\.ts:/.test(at))).toBe(true)
		expect(found.length).toBeGreaterThan(0)
	})
})
