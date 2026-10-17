/**
 * Every source file has its unit test beside it as `<name>.test.ts`, so per-file coverage is
 * earned by the file's own tests and not by a far-away integration suite. A file named like a
 * barrel or a type module (`index.ts`, `types.ts`, `*-types.ts`) is exempt only while its AST
 * proves it holds declarations and re-exports alone; with runtime code it needs a test like any
 * other file. `bin.ts` only runs as a process.
 *
 * KNOWN_MISSING may only shrink: adding a sibling for a listed file fails until the entry goes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { parseSync } from "oxc-parser"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../../src")

const KNOWN_MISSING = [
	"codegen/entity-meta.ts",
	"codegen/generators/fts-sql.ts",
	"meta.ts",
	"migrate/types.ts",
	"query/descriptions.ts",
	"query/sqlite/keyset.ts",
	"query/sqlite/pattern.ts",
	"sqlite/constraints.ts",
	"types.ts",
]

const NO_TEST = new Set(["bin.ts"])

type Statement = { type: string; declaration?: { type: string } | null; exportKind?: string; source?: unknown }

const TYPE_DECLARATIONS = new Set(["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSModuleDeclaration"])

function declares(statement: Statement): boolean {
	if (statement.type === "ImportDeclaration" || statement.type === "ExportAllDeclaration") return true
	if (TYPE_DECLARATIONS.has(statement.type)) return true
	if (statement.type !== "ExportNamedDeclaration") return false
	if (statement.exportKind === "type" || statement.source !== null) return true
	return statement.declaration === null || TYPE_DECLARATIONS.has(statement.declaration?.type ?? "")
}

/** Whether `code` holds only imports, re-exports and type declarations: nothing that runs. */
export function declarationOnly(code: string, filename = "x.ts"): boolean {
	const { program } = parseSync(filename, code)
	return (program.body as Statement[]).every(declares)
}

const exemptByName = (rel: string) => /(?:^|\/)(?:index|types|[\w-]+-types)\.ts$/.test(rel)

function sources(): string[] {
	return readdirSync(SRC, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
		.map((entry) => relative(SRC, join(entry.parentPath, entry.name)))
		.filter((rel) => !rel.split("/").includes("__fixtures__"))
		.sort()
}

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8")
const hasSibling = (rel: string) => existsSync(join(SRC, rel.replace(/\.ts$/, ".test.ts")))

/** Source files that need a sibling test: not the bin shim, not a proven declaration module. */
function needingTests(): string[] {
	return sources().filter((rel) => !NO_TEST.has(rel) && !(exemptByName(rel) && declarationOnly(read(rel), rel)))
}

describe("every source file has a sibling test", () => {
	it("each file without one is on KNOWN_MISSING", () => {
		expect(needingTests().filter((rel) => !hasSibling(rel))).toEqual(KNOWN_MISSING)
	})

	it("KNOWN_MISSING only shrinks: every entry exists and still lacks a sibling", () => {
		const stale = KNOWN_MISSING.filter((rel) => !existsSync(join(SRC, rel)) || hasSibling(rel))
		expect(stale).toEqual([])
	})

	it("every index.ts is declarations and re-exports only, which the v8 report excludes them for", () => {
		const barrels = sources().filter((rel) => basename(rel) === "index.ts")
		expect(barrels.length).toBeGreaterThan(0)
		expect(barrels.filter((rel) => !declarationOnly(read(rel), rel))).toEqual([])
	})
})

describe("the declaration-only check", () => {
	it.each([
		['export * from "./a.ts"', true],
		['export { a, b } from "./a.ts"', true],
		['export type { A } from "./a.ts"', true],
		['import type { A } from "./a.ts"\nexport type B = A[]', true],
		["export interface I {\n\ta: string\n}", true],
		['import { a } from "./a.ts"\nexport { a }', true],
		["export const a = 1", false],
		["export function f() {}", false],
		['import { z } from "zod"\nexport const s = z.string()', false],
		["export default {}", false],
		["export enum E {\n\tA,\n}", false],
	])("%s → %s", (code, expected) => {
		expect(declarationOnly(code)).toBe(expected)
	})
})
