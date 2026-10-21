/**
 * Codegen reads the consumer's sources and never runs them: no `require`, and no `import()` of
 * anything but a literal path of comb's own, anywhere in src/codegen. A constraint constant is
 * read from the AST (src/codegen/utils/constant-value.ts); running a module would run its side
 * effects and its imports, comb's own among them (the 0.10 coverage loss came from exactly that).
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const CODEGEN = join(import.meta.dirname, "../../src/codegen")

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) return entry.name === "__fixtures__" ? [] : sources(full)
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : []
	})
}

/* a call that loads a module at run time: require, createRequire, or import() of a non-literal path */
const LOADS = [/\b(?:createRequire|require)\s*\(/, /\bimport\s*\(\s*(?!["'][^"']+["']\s*\))/]

describe("codegen runs no user code", () => {
	it("holds no require, and imports only literal paths", () => {
		const found: string[] = []
		for (const file of sources(CODEGEN)) {
			for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
				/* a comment loads nothing */
				if (/^\s*(?:\*|\/\/|\/\*)/.test(line)) continue
				if (LOADS.some((pattern) => pattern.test(line)))
					found.push(`${file.slice(CODEGEN.length + 1)}:${index + 1}: ${line.trim()}`)
			}
		}
		expect(found).toEqual([])
	})
})
