import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateDiagrams } from "../../../../src/codegen/generators/diagrams.ts"

describe("generateDiagrams", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-diagrams-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTablesAndAnalyze(content: string): ReturnType<typeof analyze> {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, content)
		return analyze(fp)
	}

	it("generates DDL, JSON, and AI summary files", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
	integer: (name: string) => integer(name, { mode: "number" }),
	ref: (name: string) => text(name),
}
export const user = createTable("user", {
	id: c.id(),
	name: c.text("name").notNull(),
	age: c.integer("age"),
})
export const post = createTable("post", {
	id: c.id(),
	title: c.text("title").notNull(),
	author_id: c.ref("author_id").references(() => user.id, { onDelete: "cascade" }).notNull(),
})
`)
		const outputDir = path.join(tmpDir, "diagrams")
		generateDiagrams({ dbName: result.dbName, tables: result.tables }, { output: outputDir }, tmpDir)

		/* DDL file */
		const ddlPath = path.join(outputDir, "test-schema.gen.sql")
		expect(fs.existsSync(ddlPath)).toBe(true)
		const ddl = fs.readFileSync(ddlPath, "utf-8")
		expect(ddl).toContain("CREATE TABLE user")
		expect(ddl).toContain("CREATE TABLE post")
		expect(ddl).toContain("name TEXT NOT NULL")
		expect(ddl).toContain("REFERENCES user(id) ON DELETE CASCADE")

		/* Relations JSON */
		const jsonPath = path.join(outputDir, "test-relations.gen.json")
		expect(fs.existsSync(jsonPath)).toBe(true)
		const json = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as {
			relationCount: number
			tableCount: number
		}
		expect(json.tableCount).toBe(2)
		expect(json.relationCount).toBe(1)

		/* AI summary */
		const aiPath = path.join(outputDir, "test-ai.gen.txt")
		expect(fs.existsSync(aiPath)).toBe(true)
		const ai = fs.readFileSync(aiPath, "utf-8")
		expect(ai).toContain("2 tables")
		expect(ai).toContain("1 FKs")
	})

	it("maps Drizzle helpers to correct SQL types", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text, integer, real } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
	integer: (name: string) => integer(name, { mode: "number" }),
	boolean: (name: string) => integer(name, { mode: "boolean" }),
	real: (name: string) => real(name),
}
export const mixed = createTable("mixed", {
	id: c.id(),
	name: c.text("name"),
	count: c.integer("count"),
	active: c.boolean("active"),
	score: c.real("score"),
})
`)
		const outputDir = path.join(tmpDir, "diagrams")
		generateDiagrams({ dbName: result.dbName, tables: result.tables }, { output: outputDir }, tmpDir)

		const ddl = fs.readFileSync(path.join(outputDir, "test-schema.gen.sql"), "utf-8")
		expect(ddl).toContain("id TEXT PRIMARY KEY")
		expect(ddl).toContain("name TEXT")
		expect(ddl).toContain("count INTEGER")
		expect(ddl).toContain("active INTEGER")
		expect(ddl).toContain("score REAL")
	})
})

describe("generateDiagrams — column and reference rendering", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-diagrams-more-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function generate(body: string): { ddl: string; summary: string } {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`
import { sqliteTable as createTable, text, integer, real, blob } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (n: string) => text(n),
	integer: (n: string) => integer(n, { mode: "number" }),
	real: (n: string) => real(n),
	blob: (n: string) => blob(n),
	ref: (n: string) => text(n),
}
${body}
`,
		)
		const result = analyze(fp)
		const outputDir = path.join(tmpDir, "diagrams")
		generateDiagrams({ dbName: result.dbName, tables: result.tables }, { output: outputDir }, tmpDir)
		return {
			ddl: fs.readFileSync(path.join(outputDir, "test-schema.gen.sql"), "utf-8"),
			summary: fs.readFileSync(path.join(outputDir, "test-ai.gen.txt"), "utf-8"),
		}
	}

	it("maps each drizzle helper onto its SQL type", () => {
		const { ddl } = generate(`
export const thing = createTable("thing", {
	id: c.id(),
	count: c.integer("count"),
	ratio: c.real("ratio"),
	label: c.text("label"),
})
`)
		expect(ddl).toContain("count INTEGER")
		expect(ddl).toContain("ratio REAL")
		expect(ddl).toContain("label TEXT")
	})

	it("renders ON UPDATE alongside ON DELETE", () => {
		const { ddl } = generate(`
export const author = createTable("author", { id: c.id() })
export const post = createTable("post", {
	id: c.id(),
	author_id: c.ref("author_id").references(() => author.id, { onDelete: "set null", onUpdate: "cascade" }),
})
`)
		expect(ddl).toContain("ON DELETE SET NULL")
		expect(ddl).toContain("ON UPDATE CASCADE")
	})

	it("lists a table's own columns in the summary", () => {
		const { summary } = generate(`
export const post = createTable("post", { id: c.id(), title: c.text("title") })
`)
		expect(summary).toContain("Tables & Columns")
		expect(summary).toContain("post")
		expect(summary).toContain("title")
	})

	it("says so when a table carries only common columns", () => {
		const { summary } = generate(`
export const ping = createTable("ping", { id: c.id() })
`)
		expect(summary).toContain("(only common cols)")
	})

	it("marks each delete rule with its shorthand in the reference summary", () => {
		const { summary } = generate(`
export const author = createTable("author", { id: c.id() })
export const a = createTable("a", { id: c.id(), x: c.ref("x").references(() => author.id, { onDelete: "cascade" }) })
export const b = createTable("b", { id: c.id(), y: c.ref("y").references(() => author.id, { onDelete: "restrict" }) })
export const d = createTable("d", { id: c.id(), z: c.ref("z").references(() => author.id, { onDelete: "set null" }) })
`)
		expect(summary).toContain("[c]")
		expect(summary).toContain("[r]")
		expect(summary).toContain("[n]")
	})

	it("orders referenced tables by how many tables point at them", () => {
		const { summary } = generate(`
export const hot = createTable("hot", { id: c.id() })
export const cold = createTable("cold", { id: c.id() })
export const a = createTable("a", { id: c.id(), x: c.ref("x").references(() => hot.id) })
export const b = createTable("b", { id: c.id(), y: c.ref("y").references(() => hot.id) })
export const e = createTable("e", { id: c.id(), z: c.ref("z").references(() => cold.id) })
`)
		expect(summary).toContain("<-")
	})
})
