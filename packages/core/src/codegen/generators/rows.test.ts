import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateRows } from "./rows.ts"
import { testContext } from "./__fixtures__/context.ts"

/** A fresh temp directory per test, removed after it. */
function useTmpDir(prefix: string): () => string {
	let dir = ""
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
	})
	afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))
	return () => dir
}

/** Write `content` as the tables file in `dir` and analyze it. */
function analyzeIn(dir: string, content: string): ReturnType<typeof analyze> {
	const fp = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(fp, content)
	return analyze(fp)
}

describe("generateRows — row types", () => {
	const tmpDir = useTmpDir("comb-gen-rows-")
	const writeTablesAndAnalyze = (content: string) => analyzeIn(tmpDir(), content)

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
		const tablesPath = path.join(tmpDir(), "db.test.tables.ts")
		const outputPath = path.join(tmpDir(), "rows.gen.ts")
		generateRows(testContext(result, { cwd: tmpDir(), tablesPath: tablesPath }), { output: outputPath })

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("PostRowSelect")
		expect(content).toContain("PostRowInsert")
		expect(content).toContain("UserRowSelect")
		expect(content).toContain("UserRowInsert")
		expect(content).toContain('RowTableName = "post" | "user"')
		expect(content).toContain("$inferSelect")
		expect(content).toContain("$inferInsert")
	})

	it("warns and writes nothing for an empty table list, without exiting the caller's process", () => {
		const outputPath = path.join(tmpDir(), "rows.gen.ts")
		const ctx = testContext([], { cwd: tmpDir(), tablesPath: path.join(tmpDir(), "db.test.tables.ts") })

		generateRows(ctx, { output: outputPath })

		expect(ctx.warned).toEqual(["rows: no tables found — skipped"])
		expect(fs.existsSync(outputPath)).toBe(false)
	})
})

describe("generateRows — the tables import", () => {
	const tmpDir = useTmpDir("comb-gen-rows-")
	const writeTablesAndAnalyze = (content: string) => analyzeIn(tmpDir(), content)

	it("generates correct import path", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey() }
export const item = createTable("item", { id: c.id() })
`)
		const tablesPath = path.join(tmpDir(), "db.test.tables.ts")
		const outputPath = path.join(tmpDir(), "rows.gen.ts")
		generateRows(testContext(result, { cwd: tmpDir(), tablesPath: tablesPath }), { output: outputPath })

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain('from "./db.test.tables"')
	})

	it("keeps an import path that already leaves the output directory", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
export const item = createTable("item", { id: text("id").primaryKey() })
`)
		const outputPath = path.join(tmpDir(), "out", "rows.gen.ts")
		generateRows(testContext(result, { cwd: tmpDir(), tablesPath: path.join(tmpDir(), "db.test.tables.ts") }), {
			output: outputPath,
		})

		expect(fs.readFileSync(outputPath, "utf-8")).toContain('from "../db.test.tables"')
	})
})
