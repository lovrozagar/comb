import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { FieldMeta, TableMeta } from "../analyzer-types.ts"
import { generateFts } from "./fts.ts"
import { generateFtsSql } from "./fts-sql.ts"
import { testContext } from "./__fixtures__/context.ts"

/** generateFtsSql with its warnings collected into `warned` */
function ftsSql(tables: TableMeta[], config: Parameters<typeof generateFtsSql>[1], warned: string[] = []): string {
	return generateFtsSql(tables, config, (line) => warned.push(line))
}

function makeField(overrides: Partial<FieldMeta> & { name: string }): FieldMeta {
	return {
		constraints: {
			autogenerate: false,
			email: false,
			imageUri: false,
			lowercase: false,
			max: null,
			maxBytes: null,
			min: null,
			mutable: false,
			name: false,
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
		schemaImports: [],
		sqlName: overrides.sqlName ?? overrides.name,
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
		timestamps: {
			createdAt: false,
			deletedAt: false,
			names: { createdAt: null, deletedAt: null, updatedAt: null },
			style: "camelCase",
			updatedAt: false,
		},
		partialUniqueIndexes: [],
		uniqueIndexes: [],
		...overrides,
	}
}

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

describe("generateFtsSql — the virtual table", () => {
	it("generates virtual table with correct columns", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["title", "excerpt", "content", "keywords"] },
		})

		expect(sql).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS "article_translation_fts" USING fts5(')
		expect(sql).toContain('\t"title", "excerpt", "content", "keywords",')
		expect(sql).toContain("\tcontent='article_translation',")
		expect(sql).toContain("\tcontent_rowid='rowid',")
	})

	it("uses default tokenizer when not specified", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["title"] },
		})

		expect(sql).toContain("\ttokenize='unicode61 remove_diacritics 2'")
	})

	it("uses custom tokenizer when specified", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["title"], tokenizer: "porter ascii" },
		})

		expect(sql).toContain("\ttokenize='porter ascii'")
	})

	it("preserves column order from config", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["keywords", "content", "title"] },
		})

		expect(sql).toContain('\t"keywords", "content", "title",')
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

		const sql = ftsSql(multiTables, {
			article_translation: { columns: ["title", "content"] },
			changelog: { columns: ["title", "body"] },
		})

		expect(sql).toContain("article_translation_fts")
		expect(sql).toContain("changelog_fts")
	})

	it("returns empty string for empty config", () => {
		const sql = ftsSql(tables, {})
		expect(sql).toBe("")
	})
})

describe("generateFtsSql — triggers", () => {
	it("generates all three triggers", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["title", "content"] },
		})

		expect(sql).toContain(
			'CREATE TRIGGER IF NOT EXISTS "article_translation_fts_ai" AFTER INSERT ON "article_translation"',
		)
		expect(sql).toContain(
			'CREATE TRIGGER IF NOT EXISTS "article_translation_fts_ad" AFTER DELETE ON "article_translation"',
		)
		expect(sql).toContain(
			'CREATE TRIGGER IF NOT EXISTS "article_translation_fts_au" AFTER UPDATE ON "article_translation"',
		)
	})

	it("insert trigger uses new.rowid and new.columns", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["title", "content"] },
		})

		expect(sql).toContain('INSERT INTO "article_translation_fts"(rowid, "title", "content")')
		expect(sql).toContain('VALUES (new.rowid, new."title", new."content");')
	})

	it("delete trigger uses 'delete' command with old.columns", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["title", "content"] },
		})

		expect(sql).toContain('INSERT INTO "article_translation_fts"("article_translation_fts", rowid, "title", "content")')
		expect(sql).toContain(`VALUES ('delete', old.rowid, old."title", old."content");`)
	})

	it("update trigger deletes old then inserts new", () => {
		const sql = ftsSql(tables, {
			article_translation: { columns: ["title"] },
		})

		const lines = sql.split("\n")
		const updateTriggerStart = lines.findIndex((l) => l.includes('"article_translation_fts_au" AFTER UPDATE'))
		const triggerBody = lines.slice(updateTriggerStart, updateTriggerStart + 10).join("\n")

		expect(triggerBody).toContain(`VALUES ('delete', old.rowid, old."title");`)
		expect(triggerBody).toContain('VALUES (new.rowid, new."title");')
	})
})

describe("generateFtsSql — validation", () => {
	it("throws on unknown table", () => {
		expect(() =>
			ftsSql(tables, {
				nonexistent: { columns: ["title"] },
			}),
		).toThrow('FTS config error: table "nonexistent" not found in analyzed schema')
	})

	it("throws on unknown column", () => {
		expect(() =>
			ftsSql(tables, {
				article_translation: { columns: ["title", "nonexistent_col"] },
			}),
		).toThrow('FTS config error: column "nonexistent_col" not found in table "article_translation"')
	})

	it("deduplicates columns preserving order", () => {
		const warned: string[] = []
		const sql = ftsSql(tables, { article_translation: { columns: ["content", "title", "content"] } }, warned)

		expect(sql).toContain('\t"content", "title",')
		expect(sql).not.toContain('"content", "title", "content",')
		expect(warned).toEqual(['  fts warning: duplicate column "content" in table "article_translation" — skipped'])
	})

	it("warns on non-text columns", () => {
		const intTable = makeTable({
			fields: [makeField({ name: "title" }), makeField({ drizzleHelper: "integer", name: "minute_read" })],
			sqlName: "articles",
			varName: "articles",
		})

		const warned: string[] = []
		ftsSql([intTable], { articles: { columns: ["title", "minute_read"] } }, warned)

		expect(warned).toEqual([expect.stringContaining('column "minute_read" in table "articles" is type integer')])
	})
})

/** A fresh temp directory per test, removed after it. */
function useTmpDir(prefix: string): () => string {
	let dir = ""
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
	})
	afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))
	return () => dir
}

describe("generateFts — files", () => {
	const tmpDir = useTmpDir("comb-gen-fts-")

	it("generates both SQL and TypeScript files", () => {
		generateFts(testContext(tables, { cwd: tmpDir(), dbName: "content" }), {
			fts: { article_translation: { columns: ["title", "content"] } },
			output: tmpDir(),
		})

		expect(fs.existsSync(path.join(tmpDir(), "db.content.fts.gen.sql"))).toBe(true)
		expect(fs.existsSync(path.join(tmpDir(), "db.content.fts.gen.ts"))).toBe(true)
	})

	it("SQL file contains header comment", () => {
		generateFts(testContext(tables, { cwd: tmpDir(), dbName: "content" }), {
			fts: { article_translation: { columns: ["title"] } },
			output: tmpDir(),
		})

		const sql = fs.readFileSync(path.join(tmpDir(), "db.content.fts.gen.sql"), "utf-8")
		expect(sql).toContain("-- @generated by comb")
		expect(sql).toContain("do not edit")
	})

	it("skips silently when fts config is empty", () => {
		generateFts(testContext(tables, { cwd: tmpDir(), dbName: "content" }), {
			fts: {},
			output: tmpDir(),
		})

		expect(fs.existsSync(path.join(tmpDir(), "db.content.fts.gen.sql"))).toBe(false)
		expect(fs.existsSync(path.join(tmpDir(), "db.content.fts.gen.ts"))).toBe(false)
	})

	it("names its files by the configured filePrefix, the stem every other generator uses", () => {
		generateFts(testContext(tables, { cwd: tmpDir(), dbName: "content" }), {
			filePrefix: "app.content",
			fts: { article_translation: { columns: ["title"] } },
			output: tmpDir(),
		})

		expect(fs.readdirSync(tmpDir()).sort()).toEqual(["app.content.fts.gen.sql", "app.content.fts.gen.ts"])
	})

	it("counts every configured table in its log line", () => {
		const multi = [...tables, makeTable({ fields: [makeField({ name: "body" })], sqlName: "note", varName: "note" })]
		const ctx = testContext(multi, { cwd: tmpDir(), dbName: "content" })
		generateFts(ctx, {
			fts: { article_translation: { columns: ["title"] }, note: { columns: ["body"] } },
			output: tmpDir(),
		})

		expect(ctx.logged[0]).toMatch(/\(2 tables\)$/)
		expect(fs.readFileSync(path.join(tmpDir(), "db.content.fts.gen.ts"), "utf-8")).toContain("\tnote: {")
	})
})

describe("generateFts — the metadata map", () => {
	const tmpDir = useTmpDir("comb-gen-fts-")

	it("TypeScript file exports FTS metadata map", () => {
		generateFts(testContext(tables, { cwd: tmpDir(), dbName: "content" }), {
			fts: { article_translation: { columns: ["title", "content"] } },
			output: tmpDir(),
		})

		const ts = fs.readFileSync(path.join(tmpDir(), "db.content.fts.gen.ts"), "utf-8")
		expect(ts).toContain("CONTENT_DB_FTS")
		expect(ts).toContain('ftsTable: "article_translation_fts"')
		expect(ts).toContain('sourceTable: "article_translation"')
		expect(ts).toContain('"title", "content"')
		expect(ts).toContain("as const")
		expect(ts).toContain("export { CONTENT_DB_FTS }")
	})

	it("lists a repeated column once in the metadata map", () => {
		generateFts(testContext(tables, { cwd: tmpDir(), dbName: "content" }), {
			fts: { article_translation: { columns: ["title", "title"] } },
			output: tmpDir(),
		})

		expect(fs.readFileSync(path.join(tmpDir(), "db.content.fts.gen.ts"), "utf-8")).toContain(
			'columns: ["title"] as const',
		)
	})

	it("uses SCREAMING_SNAKE_CASE for const name", () => {
		generateFts(testContext(tables, { cwd: tmpDir(), dbName: "my-content" }), {
			fts: { article_translation: { columns: ["title"] } },
			output: tmpDir(),
		})

		const ts = fs.readFileSync(path.join(tmpDir(), "db.my-content.fts.gen.ts"), "utf-8")
		expect(ts).toContain("MY_CONTENT_DB_FTS")
	})
})
