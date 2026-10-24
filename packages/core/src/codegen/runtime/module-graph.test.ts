import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { moduleGraph, runtimeSpecifiers } from "./module-graph.ts"
import { compilerOptionsFor } from "./ts-options.mjs"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-module-graph-"))
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

function write(files: Record<string, string>): void {
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
		fs.writeFileSync(path.join(dir, name), text)
	}
}

describe("runtimeSpecifiers", () => {
	it("lists the imports and re-exports a file loads, and none only types use", () => {
		write({
			"a.ts": `import { a } from "./b"
import type { T } from "./types"
import * as ns from "pkg"
import "./side"
export { c } from "./c"
export type { U } from "./u"
export * from "./d"
export const x = [a, ns]
`,
		})
		expect(runtimeSpecifiers(path.join(dir, "a.ts"))).toEqual(["./b", "pkg", "./side", "./c", "./d"])
	})
})

/* the 4.2 review's F42a: a module only types use is loaded by no runtime, so the walk must not load it */
describe("runtimeSpecifiers: what the transpiled module imports", () => {
	const typesOnly = `import { type Bad } from "./bad"
import { Shape } from "./shape"
import { value } from "./value"
let a: Bad | undefined
let b: Shape | undefined
export const v = value
`

	it("leaves out an import of named types and one used only as a type, as transpiling elides them", () => {
		write({ "a.ts": typesOnly })
		expect(runtimeSpecifiers(path.join(dir, "a.ts"))).toEqual(["./value"])
	})

	it("keeps them under verbatimModuleSyntax, which keeps every import the source writes", () => {
		write({ "a.ts": typesOnly, "tsconfig.json": JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }) })
		expect(runtimeSpecifiers(path.join(dir, "a.ts"))).toEqual(["./bad", "./shape", "./value"])
	})
})

describe("moduleGraph", () => {
	it("follows project files as the tsconfig resolves them, and records packages by the specifier written", () => {
		write({
			"src/db/db.core.tables.ts": `import { a } from "./local"\nimport { b } from "@lib/b"\nimport z from "zod"\nimport fs from "node:fs"\nimport { gone } from "./missing"\nimport type { D } from "./decl"\nexport const all = [a, b, z, fs, gone]\n`,
			"src/db/decl.d.ts": "export type D = string\n",
			"src/db/local.ts": `import { a2 } from "./local-two"\nexport const a = a2\n`,
			"src/db/local-two.ts": `import { a } from "./local"\nexport const a2 = () => a\n`,
			"src/lib/b.ts": `import x from "drizzle-orm"\nexport const b = x\n`,
			"tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./src/lib/*"] } } }),
		})
		const graph = moduleGraph(path.join(dir, "src/db/db.core.tables.ts"))
		expect(graph.files.map((file) => path.relative(dir, file))).toEqual([
			"src/db/db.core.tables.ts",
			"src/db/local.ts",
			"src/lib/b.ts",
			"src/db/local-two.ts",
		])
		expect(graph.packages.map((each) => [path.relative(dir, each.from), each.specifier])).toEqual([
			["src/db/db.core.tables.ts", "zod"],
			["src/lib/b.ts", "drizzle-orm"],
		])
	})
})

describe("compilerOptionsFor", () => {
	it("takes the nearest tsconfig over bundler resolution, and its defaults alone without one", () => {
		expect(compilerOptionsFor("/no/such/dir/a.ts")).toEqual({ allowImportingTsExtensions: true, moduleResolution: 100 })
	})

	it("takes the nearest tsconfig, and refuses one it cannot read, naming it", () => {
		write({ "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@x/*": ["./x/*"] } } }) })
		expect(compilerOptionsFor(path.join(dir, "a.ts"))).toMatchObject({
			allowImportingTsExtensions: true,
			paths: { "@x/*": ["./x/*"] },
		})
		fs.chmodSync(path.join(dir, "tsconfig.json"), 0o000)
		expect(() => compilerOptionsFor(path.join(dir, "a.ts"))).toThrow(path.join(dir, "tsconfig.json"))
		fs.chmodSync(path.join(dir, "tsconfig.json"), 0o644)
	})
})
