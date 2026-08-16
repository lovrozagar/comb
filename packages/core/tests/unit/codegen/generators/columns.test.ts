import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateColumns } from "../../../../src/codegen/generators/columns.ts"

describe("generateColumns", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-columns-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTablesAndAnalyze(content: string): ReturnType<typeof analyze> {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, content)
		return analyze(fp)
	}

	it("generates rqb-cols, sql-cols, and table-names", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
}
export const user = createTable("user", {
	id: c.id(),
	name: c.text("name"),
	email: c.text("email"),
})
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const outputDir = path.join(tmpDir, "output")
		generateColumns(result.tables, tablesPath, { output: outputDir }, tmpDir)

		/* Check rqb-cols */
		const rqbPath = path.join(outputDir, "rqb-cols", "user", "index.gen.ts")
		expect(fs.existsSync(rqbPath)).toBe(true)
		const rqbContent = fs.readFileSync(rqbPath, "utf-8")
		expect(rqbContent).toContain("userRqbCols")
		expect(rqbContent).toContain("email: true")
		expect(rqbContent).toContain("id: true")
		expect(rqbContent).toContain("name: true")

		/* Check sql-cols */
		const sqlPath = path.join(outputDir, "sql-cols", "user", "index.gen.ts")
		expect(fs.existsSync(sqlPath)).toBe(true)
		const sqlContent = fs.readFileSync(sqlPath, "utf-8")
		expect(sqlContent).toContain("userSqlCols")
		expect(sqlContent).toContain("email: user.email")

		/* Check table-names */
		const tableNamesPath = path.join(outputDir, "table-names", "index.gen.ts")
		expect(fs.existsSync(tableNamesPath)).toBe(true)
		const tableNamesContent = fs.readFileSync(tableNamesPath, "utf-8")
		expect(tableNamesContent).toContain('user: "user"')
	})

	it("excludes private fields from column refs", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string, opts?: { private?: boolean }) => text(name),
}
export const user = createTable("user", {
	id: c.id(),
	_secret: c.text("_secret", { private: true }),
	name: c.text("name"),
})
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const outputDir = path.join(tmpDir, "output")
		generateColumns(result.tables, tablesPath, { output: outputDir }, tmpDir)

		const rqbContent = fs.readFileSync(path.join(outputDir, "rqb-cols", "user", "index.gen.ts"), "utf-8")
		expect(rqbContent).toContain("name: true")
		expect(rqbContent).not.toContain("_secret")
	})
})

describe("generateColumns — package.json exports", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-columns-pkg-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function generate(opts: { filePrefix?: string; updatePackageJson?: boolean } = {}) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey(), text: (name: string) => text(name) }
export const post = createTable("post", { id: c.id(), title: c.text("title") })
`,
		)
		const analysis = analyze(fp)
		generateColumns(analysis.tables, fp, { output: path.join(tmpDir, "cols"), ...opts }, tmpDir)
	}

	function readPkg(): Record<string, string> {
		const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8")) as {
			exports: Record<string, string>
		}
		return pkg.exports
	}

	it("leaves package.json alone unless asked", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ exports: { ".": "./x.ts" }, name: "app" }))
		generate()
		expect(readPkg()).toEqual({ ".": "./x.ts" })
	})

	it("does nothing when there is no package.json to update", () => {
		expect(() => generate({ updatePackageJson: true })).not.toThrow()
	})

	it("registers rqb-cols, sql-cols and table-names per table", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ exports: {}, name: "app" }))
		generate({ updatePackageJson: true })

		const exports = readPkg()
		expect(exports["./rqb-cols/post"]).toContain("rqb-cols/post")
		expect(exports["./sql-cols/post"]).toContain("sql-cols/post")
		expect(exports["./table-names"]).toContain("table-names")
	})

	it("preserves unrelated exports while replacing its own", () => {
		fs.writeFileSync(
			path.join(tmpDir, "package.json"),
			JSON.stringify({
				exports: {
					".": "./index.ts",
					"./rqb-cols/stale": "./gone.ts",
					"./sql-cols/stale": "./gone.ts",
					"./table-cols/stale": "./gone.ts",
					"./table-names": "./stale.ts",
				},
				name: "app",
			}),
		)
		generate({ updatePackageJson: true })

		const exports = readPkg()
		expect(exports["."]).toBe("./index.ts")
		expect(exports["./rqb-cols/stale"]).toBeUndefined()
		expect(exports["./sql-cols/stale"]).toBeUndefined()
		expect(exports["./table-cols/stale"]).toBeUndefined()
		expect(exports["./table-names"]).not.toBe("./stale.ts")
	})

	it("uses the file prefix in the generated export paths", () => {
		fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ exports: {}, name: "app" }))
		generate({ filePrefix: "app.db-test", updatePackageJson: true })

		const exports = readPkg()
		expect(exports["./rqb-cols/post"]).toContain("app.db-test.post.gen.ts")
		expect(exports["./table-names"]).toContain("app.db-test.table-names.gen.ts")
	})
})
