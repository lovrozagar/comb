import { describe, expect, it } from "vitest"
import { parseField } from "../analyze-field.ts"
import type { TableMeta } from "../analyzer-types.ts"
import { dedup, generateFtsSql } from "./fts-sql.ts"

const post: TableMeta = {
	checkConstraints: [],
	fields: [
		parseField("id", 'c.id("pst")'),
		parseField("bodyText", 'c.text("body_text")'),
		parseField("title", 'c.text("title")'),
		parseField("views", 'c.integer("views")'),
	],
	hasCompositePrimaryKey: false,
	idPrefix: "pst",
	partialUniqueIndexes: [],
	sqlName: "post",
	timestamps: { createdAt: false, deletedAt: false, style: "snake_case", updatedAt: false },
	uniqueIndexes: [],
	varName: "post",
}

function generate(config: Parameters<typeof generateFtsSql>[1]) {
	const warnings: string[] = []
	const sql = generateFtsSql([post], config, (line) => warnings.push(line))
	return { sql, warnings }
}

describe("generateFtsSql", () => {
	it("is empty without a configured table", () => {
		expect(generate({})).toEqual({ sql: "", warnings: [] })
	})

	it("writes the virtual table and its three triggers over the SQL column names", () => {
		const { sql } = generate({ post: { columns: ["title", "bodyText"] } })
		expect(sql).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(\n\ttitle, body_text,")
		expect(sql).toContain("tokenize='unicode61 remove_diacritics 2'")
		expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS post_fts_ai AFTER INSERT ON post BEGIN")
		expect(sql).toContain("VALUES ('delete', old.rowid, old.title, old.body_text);")
		expect(sql).toContain("CREATE TRIGGER IF NOT EXISTS post_fts_au AFTER UPDATE ON post BEGIN")
		expect(sql).toContain("VALUES (new.rowid, new.title, new.body_text);")
	})

	it("takes a column by its SQL name too, and a tokenizer of the config's choosing", () => {
		const { sql } = generate({ post: { columns: ["body_text"], tokenizer: "porter" } })
		expect(sql).toContain("\tbody_text,\n")
		expect(sql).toContain("tokenize='porter'")
	})

	it("warns on a repeated column and indexes it once", () => {
		const { sql, warnings } = generate({ post: { columns: ["title", "title"] } })
		expect(warnings).toEqual(['  fts warning: duplicate column "title" in table "post" — skipped'])
		expect(sql).toContain("USING fts5(\n\ttitle,\n")
	})

	it("warns on a column FTS indexes as its text form", () => {
		expect(generate({ post: { columns: ["views"] } }).warnings).toEqual([
			'  fts warning: column "views" in table "post" is type integer, will be coerced to text for FTS indexing',
		])
	})

	it("throws on a table or a column the schema lacks", () => {
		expect(() => generate({ nope: { columns: ["title"] } })).toThrow('table "nope" not found')
		expect(() => generate({ post: { columns: ["ghost"] } })).toThrow('column "ghost" not found in table "post"')
	})
})

describe("dedup", () => {
	it("keeps the first of each, in order", () => {
		expect(dedup(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"])
	})
})
