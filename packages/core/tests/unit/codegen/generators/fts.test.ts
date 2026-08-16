import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FieldMeta, TableMeta } from "../../../../src/codegen/analyzer-types.ts"
import { generateFts } from "../../../../src/codegen/generators/fts.ts"
import { generateFtsSql } from "../../../../src/codegen/generators/fts-sql.ts"

function makeField(overrides: Partial<FieldMeta> & { name: string }): FieldMeta {
	return {
		constraints: {
			autogenerate: false,
			email: false,
			lowercase: false,
			max: null,
			maxBytes: null,
			min: null,
			nomutate: false,
			password: false,
			pattern: null,
			private: false,
			tenant: false,
			trim: false,
			uppercase: false,
			url: false,
		},
		drizzleHelper: "text",
		enumName: null,
		enumValues: null,
		states: null,
		foreignKey: null,
		isNotNull: false,
		isPrimaryKey: false,
		jsonSchemaName: null,
		length: null,
		raw: "",
		...overrides,
	}
}

function makeTable(overrides: Partial<TableMeta> & { sqlName: string; varName: string }): TableMeta {
	return {
		checkConstraints: [],
		fields: [],
		hasCompositePrimaryKey: false,
		idPrefix: null,
		timestamps: { createdAt: false, deletedAt: false, style: "camelCase", updatedAt: false },
		uniqueIndexes: [],
		...overrides,
	}
}

describe("generateFtsSql", () => {
	const tables: TableMeta[] = [
		makeTable({
			fields: [
				makeField({ isPrimaryKey: true, name: "id" }),
				makeField({ name: "title" }),
				makeField({ name: "excerpt" }),
				makeField({ name: "content" }),
				makeField({ name: "keywords" }),
				makeField({ name: "locale" }),
			],
			sqlName: "article_translation",
			varName: "article_translation",
		}),
	]

	it("generates virtual table with correct columns", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["title", "excerpt", "content", "keywords"] },
		})

		expect(sql).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS article_translation_fts USING fts5(")
		expect(sql).toContain("\ttitle, excerpt, content, keywords,")
		expect(sql).toContain("\tcontent='article_translation',")
		expect(sql).toContain("\tcontent_rowid='rowid',")
	})

	it("uses default tokenizer when not specified", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["title"] },
		})

		expect(sql).toContain("\ttokenize='unicode61 remove_diacritics 2'")
	})

	it("uses custom tokenizer when specified", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["title"], tokenizer: "porter ascii" },
		})

		expect(sql).toContain("\ttokenize='porter ascii'")
	})

	it("generates all three triggers", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["title", "content"] },
		})

		expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS article_translation_fts_ai AFTER INSERT ON article_translation")
		expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS article_translation_fts_ad AFTER DELETE ON article_translation")
		expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS article_translation_fts_au AFTER UPDATE ON article_translation")
	})

	it("insert trigger uses new.rowid and new.columns", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["title", "content"] },
		})

		expect(sql).toContain("INSERT INTO article_translation_fts(rowid, title, content)")
		expect(sql).toContain("VALUES (new.rowid, new.title, new.content);")
	})

	it("delete trigger uses 'delete' command with old.columns", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["title", "content"] },
		})

		expect(sql).toContain("INSERT INTO article_translation_fts(article_translation_fts, rowid, title, content)")
		expect(sql).toContain("VALUES ('delete', old.rowid, old.title, old.content);")
	})

	it("update trigger deletes old then inserts new", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["title"] },
		})

		const lines = sql.split("\n")
		const updateTriggerStart = lines.findIndex((l) => l.includes("article_translation_fts_au AFTER UPDATE"))
		const triggerBody = lines.slice(updateTriggerStart, updateTriggerStart + 10).join("\n")

		expect(triggerBody).toContain("VALUES ('delete', old.rowid, old.title);")
		expect(triggerBody).toContain("VALUES (new.rowid, new.title);")
	})

	it("returns empty string for empty config", () => {
		const sql = generateFtsSql(tables, {})
		expect(sql).toBe("")
	})

	it("throws on unknown table", () => {
		expect(() =>
			generateFtsSql(tables, {
				nonexistent: { columns: ["title"] },
			}),
		).toThrow('FTS config error: table "nonexistent" not found in analyzed schema')
	})

	it("throws on unknown column", () => {
		expect(() =>
			generateFtsSql(tables, {
				article_translation: { columns: ["title", "nonexistent_col"] },
			}),
		).toThrow('FTS config error: column "nonexistent_col" not found in table "article_translation"')
	})

	it("deduplicates columns preserving order", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["content", "title", "content"] },
		})

		expect(sql).toContain("\tcontent, title,")
		expect(sql).not.toContain("content, title, content,")
		warnSpy.mockRestore()
	})

	it("warns on non-text columns", () => {
		const intTable = makeTable({
			fields: [makeField({ name: "title" }), makeField({ drizzleHelper: "integer", name: "minute_read" })],
			sqlName: "articles",
			varName: "articles",
		})

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		generateFtsSql([intTable], {
			articles: { columns: ["title", "minute_read"] },
		})

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('column "minute_read" in table "articles" is type integer'),
		)
		warnSpy.mockRestore()
	})

	it("preserves column order from config", () => {
		const sql = generateFtsSql(tables, {
			article_translation: { columns: ["keywords", "content", "title"] },
		})

		expect(sql).toContain("\tkeywords, content, title,")
	})

	it("generates for multiple tables", () => {
		const multiTables: TableMeta[] = [
			...tables,
			makeTable({
				fields: [makeField({ name: "title" }), makeField({ name: "body" })],
				sqlName: "changelog",
				varName: "changelog",
			}),
		]

		const sql = generateFtsSql(multiTables, {
			article_translation: { columns: ["title", "content"] },
			changelog: { columns: ["title", "body"] },
		})

		expect(sql).toContain("article_translation_fts")
		expect(sql).toContain("changelog_fts")
	})
})

describe("generateFts", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-fts-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	const tables: TableMeta[] = [
		makeTable({
			fields: [
				makeField({ isPrimaryKey: true, name: "id" }),
				makeField({ name: "title" }),
				makeField({ name: "content" }),
			],
			sqlName: "article_translation",
			varName: "article_translation",
		}),
	]

	it("generates both SQL and TypeScript files", () => {
		generateFts(
			tables,
			"content",
			{
				fts: { article_translation: { columns: ["title", "content"] } },
				output: tmpDir,
			},
			tmpDir,
		)

		expect(fs.existsSync(path.join(tmpDir, "db.content.fts.gen.sql"))).toBe(true)
		expect(fs.existsSync(path.join(tmpDir, "db.content.fts.gen.ts"))).toBe(true)
	})

	it("SQL file contains header comment", () => {
		generateFts(
			tables,
			"content",
			{
				fts: { article_translation: { columns: ["title"] } },
				output: tmpDir,
			},
			tmpDir,
		)

		const sql = fs.readFileSync(path.join(tmpDir, "db.content.fts.gen.sql"), "utf-8")
		expect(sql).toContain("-- @generated by comb")
		expect(sql).toContain("do not edit")
	})

	it("TypeScript file exports FTS metadata map", () => {
		generateFts(
			tables,
			"content",
			{
				fts: { article_translation: { columns: ["title", "content"] } },
				output: tmpDir,
			},
			tmpDir,
		)

		const ts = fs.readFileSync(path.join(tmpDir, "db.content.fts.gen.ts"), "utf-8")
		expect(ts).toContain("CONTENT_DB_FTS")
		expect(ts).toContain('ftsTable: "article_translation_fts"')
		expect(ts).toContain('sourceTable: "article_translation"')
		expect(ts).toContain('"title", "content"')
		expect(ts).toContain("as const")
		expect(ts).toContain("export { CONTENT_DB_FTS }")
	})

	it("skips silently when fts config is empty", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		generateFts(
			tables,
			"content",
			{
				fts: {},
				output: tmpDir,
			},
			tmpDir,
		)

		expect(fs.existsSync(path.join(tmpDir, "db.content.fts.gen.sql"))).toBe(false)
		expect(fs.existsSync(path.join(tmpDir, "db.content.fts.gen.ts"))).toBe(false)
		logSpy.mockRestore()
	})

	it("uses SCREAMING_SNAKE_CASE for const name", () => {
		generateFts(
			tables,
			"my-content",
			{
				fts: { article_translation: { columns: ["title"] } },
				output: tmpDir,
			},
			tmpDir,
		)

		const ts = fs.readFileSync(path.join(tmpDir, "db.my-content.fts.gen.ts"), "utf-8")
		expect(ts).toContain("MY-CONTENT_DB_FTS")
	})
})
