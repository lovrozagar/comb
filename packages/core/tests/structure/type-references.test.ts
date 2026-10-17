/**
 * comb ships TypeScript source, so a consumer's compiler reads it. A triple-slash reference to a
 * types package makes every consumer install that package, used or not: bun-types for a Node
 * project, say. Runtime-specific types come from imports inside the module that needs them.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../../src")

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) return sources(full)
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : []
	})
}

describe("shipped sources", () => {
	it("reference no types package with a triple-slash directive", () => {
		const referencing = sources(SRC).filter((file) => /^\/\/\/\s*<reference\s+types=/m.test(readFileSync(file, "utf8")))
		expect(referencing.map((file) => relative(SRC, file))).toEqual([])
	})
})
