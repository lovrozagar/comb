/**
 * The `.$type<…>()` → Zod conversion inside the DTO generator.
 *
 * Driven through generateDtos rather than by reaching for the private helpers,
 * so the assertions describe what a consumer's generated file actually says.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateDtos } from "../../../../src/codegen/generators/dtos.ts"

const PRELUDE = `
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (n: string) => text(n),
	integer: (n: string) => integer(n, { mode: "number" }),
}
`

describe("generateDtos — $type handling", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-dtos-types-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function generateFor(tsType: string, extra = ""): string {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`${PRELUDE}${extra}
export const doc = createTable("doc", {
	id: c.id(),
	data: c.text("data").$type<${tsType}>(),
})
`,
		)
		const analysis = analyze(fp)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, fp, { output: outDir }, tmpDir)
		/* Repeated schemas are hoisted into the shared module, so a column's zod
		   may live in either file. */
		return [
			fs.readFileSync(path.join(outDir, "doc", "index.gen.ts"), "utf-8"),
			fs.readFileSync(path.join(outDir, "_shared", "index.gen.ts"), "utf-8"),
		].join("\n")
	}

	it("uses a named schema referenced through z.infer", () => {
		const content = generateFor("z.infer<typeof settingsSchema>")
		expect(content).toContain("settingsSchema")
	})

	it("falls back to the column helper's own schema for a structural type", () => {
		/* Only a named schema is adopted; a structural type is described by the
		   column helper (here c.text), so the generated field stays a string. */
		const content = generateFor("{ a: string }")
		expect(content).not.toContain("z.object({ a:")
		expect(content).toMatch(/_str|z\.string\(\)/)
	})

	it("is unfazed by angle brackets inside a type argument", () => {
		expect(() => generateFor("Record<string, number>")).not.toThrow()
	})

	it("is unfazed by a string literal containing a closing angle bracket", () => {
		expect(() => generateFor(`"a>b"`)).not.toThrow()
	})

	it("tolerates a malformed, unclosed type argument", () => {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`${PRELUDE}
export const doc = createTable("doc", { id: c.id(), data: c.text("data") })
`,
		)
		const analysis = analyze(fp)
		expect(() => generateDtos(analysis, fp, { output: path.join(tmpDir, "dtos") }, tmpDir)).not.toThrow()
	})
})

describe("generateDtos — package.json exports", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-dtos-pkg-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function generate(opts: { filePrefix?: string; updatePackageJson?: boolean } = {}) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`${PRELUDE}
export const post = createTable("post", { id: c.id(), title: c.text("title") })
export const author = createTable("author", { id: c.id(), name: c.text("name") })
`,
		)
		const analysis = analyze(fp)
		generateDtos(analysis, fp, { output: path.join(tmpDir, "dtos"), ...opts }, tmpDir)
	}

	function exportsOf(): Record<string, string> {
		const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as {
			exports: Record<string, string>
		}
		return pkg.exports
	}

	it("leaves package.json untouched unless asked", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ exports: { ".": "./x.ts" }, name: "app" }))
		generate()
		expect(exportsOf()).toEqual({ ".": "./x.ts" })
	})

	it("warns rather than throwing when there is no package.json", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		expect(() => generate({ updatePackageJson: true })).not.toThrow()
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("package.json not found"))
		warn.mockRestore()
	})

	it("registers one export per entity plus the shared module", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ exports: {}, name: "app" }))
		generate({ updatePackageJson: true })

		const exports = exportsOf()
		expect(Object.keys(exports).some((k) => k.includes("post"))).toBe(true)
		expect(Object.keys(exports).some((k) => k.includes("author"))).toBe(true)
	})

	it("preserves exports it does not own", () => {
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({ exports: { ".": "./index.ts", "./custom": "./custom.ts" }, name: "app" }),
		)
		generate({ updatePackageJson: true })

		const exports = exportsOf()
		expect(exports["."]).toBe("./index.ts")
		expect(exports["./custom"]).toBe("./custom.ts")
	})

	it("uses the file prefix in the generated file names", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ exports: {}, name: "app" }))
		generate({ filePrefix: "app.db-test", updatePackageJson: true })

		expect(fs.existsSync(path.join(tmpDir, "dtos", "post", "app.db-test.post.gen.ts"))).toBe(true)
		expect(Object.values(exportsOf()).some((v) => v.includes("app.db-test"))).toBe(true)
	})
})
