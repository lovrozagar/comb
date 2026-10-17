import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { findNearestPackageJson, readExports, setPackageExport } from "./package-json.ts"

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

	it("points the subpath at the file relative to the package, last, keeping the other exports", () => {
		const file = path.join(dir, "package.json")
		fs.writeFileSync(file, JSON.stringify({ exports: { "./entities": "./old.ts", "./x": "./x.ts" }, name: "app" }))
		setPackageExport(file, "./entities", path.join(dir, "src", "e.gen.ts"))
		const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as { exports: Record<string, string>; name: string }
		expect(Object.entries(pkg.exports)).toEqual([
			["./x", "./x.ts"],
			["./entities", "./src/e.gen.ts"],
		])
		expect(pkg.name).toBe("app")
	})
})
