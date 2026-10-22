import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { exportKey, findNearestPackageJson, ownsKey, readExports, setPackageExport } from "./package-json.ts"

describe("readExports", () => {
	it("reads the subpath map whichever form package.json writes it in", () => {
		expect(readExports({ exports: "./index.ts" })).toEqual({ ".": "./index.ts" })
		expect(readExports({ exports: { ".": "./index.ts", "./x": { default: "./x.ts", types: "./x.d.ts" } } })).toEqual({
			".": "./index.ts",
			"./x": { default: "./x.ts", types: "./x.d.ts" },
		})
		expect(readExports({ exports: { default: "./index.ts", import: "./index.mjs" } })).toEqual({
			".": { default: "./index.ts", import: "./index.mjs" },
		})
		expect(readExports({})).toEqual({})
		expect(readExports({ exports: null })).toEqual({})
		expect(readExports({ exports: ["./a.ts"] })).toEqual({ ".": ["./a.ts"] })
	})
})

describe("findNearestPackageJson and setPackageExport", () => {
	let dir: string
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-package-json-"))
	})
	afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

	it("finds the package.json in the closest directory above, and null when none exists", () => {
		const nested = path.join(dir, "src", "gen")
		fs.mkdirSync(nested, { recursive: true })
		expect(findNearestPackageJson(nested)).toBeNull()
		fs.writeFileSync(path.join(dir, "package.json"), "{}")
		expect(findNearestPackageJson(nested)).toBe(path.join(dir, "package.json"))
	})

	it("stops at the project root: a package above it is not the project's to rewrite", () => {
		fs.writeFileSync(path.join(dir, "package.json"), "{}")
		const project = path.join(dir, "project")
		const nested = path.join(project, "src", "gen")
		fs.mkdirSync(nested, { recursive: true })
		expect(findNearestPackageJson(nested, project)).toBeNull()
		fs.writeFileSync(path.join(project, "package.json"), "{}")
		expect(findNearestPackageJson(nested, project)).toBe(path.join(project, "package.json"))
	})

	it("points the subpath at the file relative to the package, in key order, keeping the other exports", () => {
		const file = path.join(dir, "package.json")
		fs.writeFileSync(file, JSON.stringify({ exports: { "./entities": "./old.ts", "./x": "./x.ts" }, name: "app" }))
		setPackageExport(file, { subpath: "./entities" }, path.join(dir, "src", "e.gen.ts"))
		const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { exports: Record<string, string>; name: string }
		expect(Object.entries(pkg.exports)).toEqual([
			["./entities", "./src/e.gen.ts"],
			["./x", "./x.ts"],
		])
		expect(pkg.name).toBe("app")
	})

	it("writes under the database's namespace, dropping the unnamespaced key, and leaves another namespace alone", () => {
		const file = path.join(dir, "package.json")
		const before = { "./audit/entities": "./a.ts", "./entities": "./old.ts" }
		fs.writeFileSync(file, JSON.stringify({ exports: before }))
		setPackageExport(file, { namespace: "core", subpath: "./entities" }, path.join(dir, "c.gen.ts"))
		const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { exports: Record<string, string> }
		expect(pkg.exports).toEqual({ "./audit/entities": "./a.ts", "./core/entities": "./c.gen.ts" })
	})
})

const dtos = (key: string) => key.startsWith("./dtos/")

describe("exportKey and ownsKey", () => {
	it("namespace a subpath, and own a database's keys in either form, never another database's", () => {
		expect(exportKey(undefined, "./dtos/x")).toBe("./dtos/x")
		expect(exportKey("core", "./dtos/x")).toBe("./core/dtos/x")
		expect(ownsKey("core", "./core/dtos/x", dtos)).toBe(true)
		expect(ownsKey("core", "./dtos/x", dtos)).toBe(true)
		expect(ownsKey("core", "./audit/dtos/x", dtos)).toBe(false)
		expect(ownsKey(undefined, "./audit/dtos/x", dtos)).toBe(false)
		expect(ownsKey("core", "./core/tables", dtos)).toBe(false)
	})
})

describe("setPackageExport: the same bytes whatever the order it runs in (F32)", () => {
	it("writes . first, then every subpath by key", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-pkg-order-"))
		try {
			const file = path.join(dir, "package.json")
			const run = (order: string[]) => {
				fs.writeFileSync(file, JSON.stringify({ exports: { ".": "./index.ts", "./z": "./z.ts" }, name: "app" }))
				for (const subpath of order) setPackageExport(file, { subpath }, path.join(dir, `${subpath.slice(2)}.gen.ts`))
				return fs.readFileSync(file, "utf8")
			}
			const one = run(["./b", "./a"])
			expect(run(["./a", "./b"])).toBe(one)
			expect(Object.keys((JSON.parse(one) as { exports: object }).exports)).toEqual([".", "./a", "./b", "./z"])
		} finally {
			fs.rmSync(dir, { force: true, recursive: true })
		}
	})
})
