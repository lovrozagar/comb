/**
 * comb starts processes in one place, src/migrate/core/process.ts. Everything else takes a `Run`,
 * so atlas, wrangler and drizzle-kit calls are testable with a fake and the real spawner is
 * tested once.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../../src")
const BOUNDARY = "migrate/core/process.ts"

const SPAWNS =
	/\bfrom\s+["'](?:node:)?child_process["']|\bimport\(\s*["'](?:node:)?child_process["']\s*\)|\brequire\(\s*["'](?:node:)?child_process["']\s*\)|\bBun\s*\.\s*(?:spawn|spawnSync|\$)\b|\bBun\.\$`/

/** Whether `text` starts a process directly, by import of child_process or by Bun.spawn. */
export function spawnsDirectly(text: string): boolean {
	return SPAWNS.test(text)
}

function sources(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
		.map((entry) => join(entry.parentPath, entry.name))
}

describe("single process boundary", () => {
	it("only src/migrate/core/process.ts starts a process", () => {
		const spawners = sources(SRC)
			.filter((file) => spawnsDirectly(readFileSync(file, "utf8")))
			.map((file) => relative(SRC, file))
		expect(spawners).toEqual([BOUNDARY])
	})

	it.each([
		['import { spawnSync } from "node:child_process"', true],
		["import { execSync } from 'child_process'", true],
		['const cp = await import("node:child_process")', true],
		['const cp = require("child_process")', true],
		['const p = Bun.spawn(["wrangler"])', true],
		["const p = Bun.spawnSync(['x'])", true],
		["await Bun.$`ls`", true],
		['import type { Run } from "./process.ts"', false],
		['const s = "child_process is banned"', false],
		["const v = Bun.version", false],
	])("the checker: %s → %s", (text, expected) => {
		expect(spawnsDirectly(text)).toBe(expected)
	})
})
