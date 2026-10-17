import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AnalysisResult } from "../../analyzer-types.ts"
import { updatePackageJson } from "./package-exports.ts"

describe("updatePackageJson", () => {
	let dir: string
	let lines: string[]

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-pkg-exports-"))
		lines = []
	})

	afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

	function run(exports: unknown, filePrefix?: string): Record<string, unknown> {
		const file = path.join(dir, "package.json")
		fs.writeFileSync(file, JSON.stringify({ exports, name: "app" }))
		const ctx = {
			analysis: {} as AnalysisResult,
			cwd: dir,
			log: (line: string) => lines.push(line),
			tablesPath: path.join(dir, "src/db.blog.tables.ts"),
		}
		updatePackageJson(file, { config: { filePrefix, output: "src/dtos" }, ctx, entities: ["post", "blogAuthor"] })
		return (JSON.parse(fs.readFileSync(file, "utf8")) as { exports: Record<string, unknown> }).exports
	}

	it("keeps . first, then the generated subpaths, then what the package already had", () => {
		const exports = run({ ".": "./index.ts", "./dtos/old": "./gone.ts", "./tables": "./old.ts", "./x": "./x.ts" })
		expect(Object.entries(exports)).toEqual([
			[".", "./index.ts"],
			["./dtos/_shared", "./src/dtos/_shared/index.gen.ts"],
			["./dtos/blog-author", "./src/dtos/blog-author/index.gen.ts"],
			["./dtos/post", "./src/dtos/post/index.gen.ts"],
			["./relations", "./src/db.blog.relations.gen.ts"],
			["./tables", "./src/db.blog.tables.ts"],
			["./x", "./x.ts"],
		])
		expect(lines).toEqual(["Updated package.json exports with 2 entities"])
	})

	it("keeps a package's single-target or condition-map exports as its . export (S-13)", () => {
		expect(run("./index.ts")["."]).toBe("./index.ts")
		expect(run({ default: "./index.ts", types: "./index.d.ts" })["."]).toEqual({
			default: "./index.ts",
			types: "./index.d.ts",
		})
	})

	it("uses the file prefix for every generated file, and adds no . when the package had none", () => {
		const exports = run(undefined, "db.blog")
		expect(exports["."]).toBeUndefined()
		expect(exports["./dtos/post"]).toBe("./src/dtos/post/db.blog.post.gen.ts")
		expect(exports["./dtos/_shared"]).toBe("./src/dtos/_shared/db.blog._shared.gen.ts")
		expect(exports["./relations"]).toBe("./src/db.blog.relations.gen.ts")
	})
})
