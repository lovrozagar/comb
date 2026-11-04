/**
 * comb makes a scratch directory in one place, src/migrate/core/cleanup.ts (S2 and KC5 of r22): a
 * name carrying its process, so a later run sweeps a killed one's at once, and a removal SIGINT and
 * SIGTERM run too. A directory made anywhere else outlives a Ctrl-C, with whatever it held: a
 * migrations copy, a snapshot, an Atlas config naming the target's URL.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../../src")
const BOUNDARY = "migrate/core/cleanup.ts"

const MAKES = /\bmkdtemp(?:Sync|Disposable(?:Sync)?)?\s*\(/

/** Whether `text` makes a temporary directory itself */
export function makesScratch(text: string): boolean {
	return MAKES.test(text)
}

/* the shipped sources: a test and its fixtures make what they like */
function sources(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name) && !entry.name.endsWith(".test.ts"))
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((file) => !relative(SRC, file).split("/").includes("__fixtures__"))
}

describe("single scratch boundary (S2 and KC5 of r22; sibling: the single process boundary)", () => {
	it("only src/migrate/core/cleanup.ts makes a scratch directory", () => {
		const makers = sources(SRC)
			.filter((file) => makesScratch(readFileSync(file, "utf8")))
			.map((file) => relative(SRC, file))
		expect(makers).toEqual([BOUNDARY])
	})

	it.each([
		['const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-x-"))', true],
		['const dir = mkdtempSync(join(tmpdir(), "comb-x-"))', true],
		['const dir = await mkdtemp("comb-x-")', true],
		['using dir = fs.mkdtempDisposableSync("comb-x-")', true],
		['const { dir, remove } = scratchDir("comb-x-")', false],
		['const s = "mkdtemp is banned"', false],
	])("the checker: %s → %s", (text, expected) => {
		expect(makesScratch(text)).toBe(expected)
	})
})
