import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { install, load, loadSync, resolve, resolveSync } from "./node-hooks.mjs"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-node-hooks-"))
	fs.mkdirSync(path.join(dir, "src/lib"), { recursive: true })
	fs.writeFileSync(path.join(dir, "src/lib/enums.ts"), "export const STATES = ['a'] as const\n")
	fs.writeFileSync(
		path.join(dir, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { paths: { "@lib/*": ["./src/lib/*"] } } }),
	)
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

const parent = () => pathToFileURL(path.join(dir, "src/db.tables.ts")).href
const notFound = () => {
	throw Object.assign(new Error("Cannot find module"), { code: "ERR_MODULE_NOT_FOUND" })
}
const failing = async () => notFound()

describe("resolveSync", () => {
	it("takes node's own resolution when it finds the module", () => {
		const next = vi.fn(() => ({ url: "file:///found.js" }))
		expect(resolveSync("./x.ts", { parentURL: parent() }, next)).toEqual({ url: "file:///found.js" })
	})

	it("resolves what node cannot through the consumer's tsconfig, from a TypeScript parent", () => {
		expect(resolveSync("@lib/enums", { parentURL: parent() }, notFound)).toEqual({
			shortCircuit: true,
			url: pathToFileURL(path.join(dir, "src/lib/enums.ts")).href,
		})
		expect(
			resolveSync("../src/lib/enums", { parentURL: pathToFileURL(path.join(dir, "src/x.ts")).href }, notFound).url,
		).toBe(pathToFileURL(path.join(dir, "src/lib/enums.ts")).href)
	})

	it("rethrows node's error for what neither finds, a package, a JavaScript parent or none", () => {
		expect(() => resolveSync("@lib/nothing", { parentURL: parent() }, notFound)).toThrow("Cannot find module")
		expect(() => resolveSync("zod", { parentURL: parent() }, notFound)).toThrow("Cannot find module")
		expect(() =>
			resolveSync("@lib/enums", { parentURL: pathToFileURL(path.join(dir, "x.js")).href }, notFound),
		).toThrow()
		expect(() => resolveSync("@lib/enums", { parentURL: "data:text/javascript,1" }, notFound)).toThrow()
		expect(() => resolveSync("@lib/enums", {}, notFound)).toThrow()
	})
})

describe("loadSync", () => {
	it("transpiles a TypeScript file to the ES module it is, types gone", () => {
		const file = path.join(dir, "src/lib/enums.ts")
		const loaded = loadSync(pathToFileURL(file).href, {}, () => {
			throw new Error("not called")
		}) as { format: string; source: string }
		expect(loaded.format).toBe("module")
		expect(loaded.source).toContain("export const STATES = ['a'];")
	})

	it("hands any other file to node", () => {
		const next = vi.fn(() => ({ format: "module", source: "x" }))
		expect(loadSync("file:///a.js", {}, next)).toEqual({ format: "module", source: "x" })
		expect(loadSync("node:fs", {}, next)).toEqual({ format: "module", source: "x" })
	})
})

describe("the hooks module.register runs off-thread", () => {
	it("resolve awaits node and falls back to the tsconfig as resolveSync does", async () => {
		await expect(resolve("./x.ts", { parentURL: parent() }, async () => ({ url: "file:///x.ts" }))).resolves.toEqual({
			url: "file:///x.ts",
		})
		await expect(resolve("@lib/enums", { parentURL: parent() }, failing)).resolves.toMatchObject({ shortCircuit: true })
		await expect(resolve("zod", { parentURL: parent() }, failing)).rejects.toThrow("Cannot find module")
	})

	it("load transpiles as loadSync does", async () => {
		const url = pathToFileURL(path.join(dir, "src/lib/enums.ts")).href
		await expect(load(url, {}, async () => ({}))).resolves.toMatchObject({ format: "module" })
	})
})

describe("install", () => {
	it("registers in-thread with registerHooks where node has it, else off-thread with register", () => {
		const registerHooks = vi.fn(() => ({ deregister: () => {} }))
		const register = vi.fn()
		expect(install({ register, registerHooks })).toEqual({ deregister: expect.any(Function) })
		expect(registerHooks).toHaveBeenCalledWith({ load: loadSync, resolve: resolveSync })
		expect(install({ register })).toBeUndefined()
		expect(register).toHaveBeenCalledWith(expect.stringMatching(/node-hooks\.mjs$/))
	})
})

describe("loadSync: a TypeScript URL with a query", () => {
	it("transpiles it as the file it names, as comb imports comb.config.ts with ?mtime=", () => {
		const url = `${pathToFileURL(path.join(dir, "src/lib/enums.ts")).href}?mtime=1`
		const loaded = loadSync(url, {}, () => {
			throw new Error("not called")
		}) as { format: string }
		expect(loaded.format).toBe("module")
	})
})

/*
 * F54 of the 0.13.0 round: node loads a TypeScript file in the format node itself gives it (type
 * stripping): a .cts file, or one of a package with no "type": "module" that has no module syntax
 * once its types are stripped, as CommonJS; anything else as an ES module
 */
const REQUIRES = "const path = require('node:path')\nexport = path.join(__dirname, 'x')\n"

/** loadSync's answer for `file` holding `source`, under a package.json of `pkg` when given */
function formatOf(file: string, source: string, pkg?: Record<string, unknown>) {
	if (pkg !== undefined) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg))
	const at = path.join(dir, file)
	fs.mkdirSync(path.dirname(at), { recursive: true })
	fs.writeFileSync(at, source)
	return loadSync(pathToFileURL(at).href, {}, () => ({})) as { format: string; source: string }
}

describe("loadSync: a TypeScript file's format, as node gives it (F54)", () => {
	it("loads a file of a package with no type and no module syntax as CommonJS, transpiled to it", () => {
		const { format, source } = formatOf("db.tables.ts", REQUIRES, { name: "app" })
		expect(format).toBe("commonjs")
		expect(source).toContain("__dirname")
		/* an import only types use is stripped, as node strips it, and leaves no module syntax */
		expect(formatOf("t.ts", `import type { X } from "./x"\nconst x: X | null = null\n${REQUIRES}`).format).toBe(
			"commonjs",
		)
	})

	it("loads one with module syntax as an ES module, as node detects it in a package with no type", () => {
		const modules = [
			"import path from 'node:path'\n",
			"export const a = 1\n",
			"export default 1\n",
			"export { a } from './a'\n",
			"const u = import.meta.url\n",
			"function f() { return import.meta.url }\n",
			"await Promise.resolve()\n",
			"for await (const x of []) {}\n",
		]
		for (const source of modules)
			expect(formatOf("db.tables.ts", source, { name: "app" }).format, source).toBe("module")
	})

	it("takes what node strips or runs in CommonJS as no module syntax: types, ambient exports, export =, a function's await", () => {
		const scripts = [
			"export type A = string\n",
			"export interface B { b: string }\n",
			"export type { C } from './c'\n",
			"export declare const d: number\n",
			"const e = 1\nexport = e\n",
			"async function f() { await Promise.resolve() }\n",
			"class G { static { void 0 } }\n",
		]
		for (const source of scripts)
			expect(formatOf("db.tables.ts", source, { name: "app" }).format, source).toBe("commonjs")
	})

	it("follows the nearest package.json's type, and takes .cts and .mts by their extension", () => {
		expect(formatOf("db.tables.ts", REQUIRES, { type: "module" }).format).toBe("module")
		fs.mkdirSync(path.join(dir, "cjs"))
		fs.writeFileSync(path.join(dir, "cjs/package.json"), JSON.stringify({ type: "commonjs" }))
		expect(formatOf("cjs/db.tables.ts", "import path from 'node:path'\nexport const p = path\n").format).toBe(
			"commonjs",
		)
		expect(formatOf("a.cts", "import path from 'node:path'\nexport = path\n", { type: "module" }).format).toBe(
			"commonjs",
		)
		expect(formatOf("b.mts", REQUIRES.replace("export = ", "export default "), { name: "app" }).format).toBe("module")
	})
})
