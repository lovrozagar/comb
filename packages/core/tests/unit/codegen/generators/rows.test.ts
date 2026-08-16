import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateRows } from "../../../../src/codegen/generators/rows.ts"

describe("generateRows", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-rows-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTablesAndAnalyze(content: string): ReturnType<typeof analyze> {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, content)
		return analyze(fp)
	}

	it("generates row types for each table", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id(), name: c.text("name") })
export const post = createTable("post", { id: c.id(), title: c.text("title") })
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const outputPath = path.join(tmpDir, "rows.gen.ts")
		generateRows(result.tables, tablesPath, { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("PostRowSelect")
		expect(content).toContain("PostRowInsert")
		expect(content).toContain("UserRowSelect")
		expect(content).toContain("UserRowInsert")
		expect(content).toContain('RowTableName = "post" | "user"')
		expect(content).toContain("$inferSelect")
		expect(content).toContain("$inferInsert")
	})

	it("generates correct import path", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey() }
export const item = createTable("item", { id: c.id() })
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const outputPath = path.join(tmpDir, "rows.gen.ts")
		generateRows(result.tables, tablesPath, { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain('from "./db.test.tables"')
	})
})
