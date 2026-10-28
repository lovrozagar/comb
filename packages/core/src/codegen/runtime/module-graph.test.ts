import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

/* F44 of the 0.13.0 round: a call of import() or require() loads its module only when the code runs,
   so codegen, which imports what the tables module loads at once, must not load it */
describe("runtimeSpecifiers: a module loaded on demand", () => {
	it("leaves out import() and require() calls, at the top level or in a function, in an ES module", () => {
		write({
			"a.ts": `import { a } from "./b"
import fs = require("./legacy")
export async function seed() {
	await import("./seed")
	require("./other")
}
const lazy = import("./lazy")
export const x = [a, fs, lazy]
`,
		})
		/* `import fs = require` is no ES module syntax: transpiled as one, it is gone, and loads nothing */
		expect(runtimeSpecifiers(path.join(dir, "a.ts"))).toEqual(["./b"])
	})

	it("walks no file a tables module imports only on demand", () => {
		write({
			"db.tables.ts": `export const t = 1\nexport async function seed() { await import("./seed.ts") }\n`,
			"seed.ts": `export const seeded = true\n`,
		})
		expect(moduleGraph(path.join(dir, "db.tables.ts")).files.map((file) => path.basename(file))).toEqual([
			"db.tables.ts",
		])
	})
})

/* F44 with F54 in view: in a CommonJS file, a top-level require is that file's static import */
describe("runtimeSpecifiers: a CommonJS module's top-level requires", () => {
	it("walks a CommonJS tables module's top-level require of its sibling, its static import, but not one in a function", () => {
		write({
			"cjs/package.json": JSON.stringify({ name: "cjs-app" }),
			"cjs/db.tables.ts": `const columns = require("./columns")\nrequire("./side")\nexports.t = columns.t\nexports.seed = () => require("./seed")\n`,
			"cjs/columns.ts": `exports.t = 1\n`,
			"cjs/side.ts": `exports.s = 1\n`,
			"cjs/seed.ts": `exports.seeded = true\n`,
		})
		expect(runtimeSpecifiers(path.join(dir, "cjs/db.tables.ts"))).toEqual(["./columns", "./side"])
		expect(moduleGraph(path.join(dir, "cjs/db.tables.ts")).files.map((file) => path.basename(file))).toEqual([
			"db.tables.ts",
			"columns.ts",
			"side.ts",
		])
	})

	it("reads a top-level require as no import in an ES module, which has no require", () => {
		write({
			"esm/package.json": JSON.stringify({ type: "module" }),
			"esm/a.ts": `const b = require("./b")\nexport const x = b\n`,
		})
		expect(runtimeSpecifiers(path.join(dir, "esm/a.ts"))).toEqual([])
	})

	it("reads a .cjs file as CommonJS and an .mjs one as an ES module, whatever the package says, and only a literal require", () => {
		write({
			"cjs/package.json": JSON.stringify({ name: "cjs-app" }),
			"cjs/a.cjs": `const p = require("./p").value\nconst name = "./dynamic"\nconst d = require(name)\nconst plain = 1\nfunction later() { return require("./later") }\nexports.x = [p, d, plain, later]\n`,
			"cjs/b.mjs": `const c = require("./c")\nexport const x = c\n`,
			"esm/package.json": JSON.stringify({ type: "module" }),
			"esm/c.cjs": `require("./d")\n`,
		})
		expect(runtimeSpecifiers(path.join(dir, "cjs/a.cjs"))).toEqual(["./p"])
		expect(runtimeSpecifiers(path.join(dir, "cjs/b.mjs"))).toEqual([])
		expect(runtimeSpecifiers(path.join(dir, "esm/c.cjs"))).toEqual(["./d"])
	})

	it("reads a file with no package.json above it as CommonJS, as node does", () => {
		const loose = fs.mkdtempSync(path.join(os.tmpdir(), "comb-module-graph-"))
		try {
			fs.writeFileSync(path.join(loose, "a.ts"), `require("./b")\n`)
			/* the walk sees only the scratch directory: a package.json above the system's temp directory is the machine's, not the test's */
			const real = fs.existsSync
			vi.spyOn(fs, "existsSync").mockImplementation((file) => String(file).startsWith(loose) && real(file))
			expect(runtimeSpecifiers(path.join(loose, "a.ts"))).toEqual(["./b"])
		} finally {
			vi.restoreAllMocks()
			fs.rmSync(loose, { force: true, recursive: true })
		}
	})
})

/* F52: the walk follows what the runtime loads, not what TypeScript resolves for types */
describe("moduleGraph: the files the runtime loads", () => {
	it("walks a declaration's runtime file, and no asset or declaration that has none", () => {
		write({
			"a.ts": `import roles from "./roles.json" with { type: "json" }
import { b } from "./b.js"
import { c } from "./c.mjs"
import { d } from "./d.cjs"
import { e } from "./e.js"
export const all = [roles, b, c, d, e]
`,
			"roles.json": "[]",
			"b.js": "export const b = 1\n",
			"b.d.ts": "export declare const b: number\n",
			"c.mjs": "export const c = 1\n",
			"c.d.mts": "export declare const c: number\n",
			"d.cjs": "exports.d = 1\n",
			"d.d.cts": "export declare const d: number\n",
			/* a declaration with no runtime file beside it: nothing to load */
			"e.d.ts": "export declare const e: number\n",
			"tsconfig.json": JSON.stringify({
				compilerOptions: { allowJs: false, module: "nodenext", resolveJsonModule: true },
			}),
		})
		const files = moduleGraph(path.join(dir, "a.ts")).files.map((file) => path.relative(dir, file))
		expect(files).toEqual(["a.ts", "b.js", "c.mjs", "d.cjs"])
	})
})
