/**
 * HN2 of plan 21: `bun run test:bun` gates only drivers/bun-sqlite.ts at 100% and leaves every other
 * file to vitest (docs/testing.md), by listing it in bunfig's coveragePathIgnorePatterns. A bun suite
 * that comes to load one more src file failed test:bun with a bare percentage (e96f568^), so each
 * src file the patterns miss is named here, with the fix.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, matchesGlob, relative } from "node:path"
import { describe, expect, it } from "vitest"

const CORE = join(import.meta.dirname, "../..")

/* the one file test:bun measures: it imports bun:sqlite, which vitest cannot load */
const MEASURED = "src/migrate/drivers/bun-sqlite.ts"

/** The globs of bunfig's coveragePathIgnorePatterns */
function ignorePatterns(bunfig: string): string[] {
	const list = /^coveragePathIgnorePatterns = \[([\s\S]*?)^\]/m.exec(bunfig)?.[1] ?? ""
	return [...list.matchAll(/^\s*"([^"]+)",?\s*$/gm)].map((match) => match[1] as string)
}

/** Every src file bun's coverage would count: the .ts files but tests, which coverageSkipTestFiles leaves out */
const SOURCES = readdirSync(join(CORE, "src"), { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
	.map((entry) => relative(CORE, join(entry.parentPath, entry.name)))
	.toSorted()

describe("bun's coverage, left to vitest but for bun-sqlite.ts (HN2; sibling: workflows' bunfig preload)", () => {
	const patterns = ignorePatterns(readFileSync(join(CORE, "bunfig.toml"), "utf8"))
	const ignored = (file: string): boolean => patterns.some((pattern) => matchesGlob(file, pattern))

	it("ignores every src file but bun-sqlite.ts", () => {
		const missed = SOURCES.filter((file) => file !== MEASURED && !ignored(file)).map(
			(file) => `${file}: add it to bunfig's coveragePathIgnorePatterns; vitest measures it`,
		)
		expect(missed).toEqual([])
	})

	it("measures bun-sqlite.ts", () => {
		expect(SOURCES).toContain(MEASURED)
		expect(ignored(MEASURED)).toBe(false)
	})
})
