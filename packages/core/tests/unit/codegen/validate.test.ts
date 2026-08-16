import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateTables } from "../../../src/codegen/utils/validate.ts"

describe("validateTables", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-validate-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTables(content: string): string {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, content)
		return fp
	}

	it("returns no errors for valid schema", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey() }
export const user = createTable("user", { id: c.id() })
`)
		const result = validateTables(fp)
		expect(result.errors).toHaveLength(0)
	})

	it("warns about missing primary key", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { text: (name: string) => text(name) }
export const log = createTable("log", { msg: c.text("msg") })
`)
		const result = validateTables(fp)
		expect(result.warnings.some((w) => w.includes("no primary key"))).toBe(true)
	})

	it("errors on duplicate table names", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey() }
export const user = createTable("user", { id: c.id() })
export const user2 = createTable("user", { id: c.id() })
`)
		const result = validateTables(fp)
		expect(result.errors.some((e) => e.includes("Duplicate SQL table name"))).toBe(true)
	})

	it("errors on FK referencing non-existent table", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const post = createTable("post", {
	id: c.id(),
	author_id: c.ref("author_id").references(() => missing_table.id),
})
`)
		const result = validateTables(fp)
		expect(result.errors.some((e) => e.includes("FK references"))).toBe(true)
	})

	it("returns clean result for multi-table schema with valid FKs", () => {
		const fp = writeTables(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id() })
export const post = createTable("post", {
	id: c.id(),
	user_id: c.ref("user_id").references(() => user.id),
})
`)
		const result = validateTables(fp)
		expect(result.errors).toHaveLength(0)
	})
})

describe("validateTables — structural checks", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-validate-more-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	const PRELUDE = `
import { sqliteTable as createTable, text, uniqueIndex, check } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
const c = { id: () => text("id").primaryKey(), text: (n: string) => text(n), ref: (n: string) => text(n) }
`

	function validate(body: string) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + body)
		return validateTables(fp)
	}

	it("rejects two tables sharing one SQL name", () => {
		const result = validate(`
export const a = createTable("post", { id: c.id() })
export const b = createTable("post", { id: c.id() })
`)
		expect(result.errors.join("\n")).toContain("Duplicate SQL table name")
	})

	it("rejects a duplicated field within a table", () => {
		const result = validate(`
export const post = createTable("post", { id: c.id(), title: c.text("title"), title: c.text("title") })
`)
		expect(result.errors.join("\n")).toContain('duplicate field "title"')
	})

	it("rejects a foreign key pointing at a table that is not defined", () => {
		const result = validate(`
export const post = createTable("post", { id: c.id(), author_id: c.ref("author_id").references(() => author.id) })
`)
		expect(result.errors.join("\n")).toContain('FK references "author"')
	})

	it("accepts a foreign key whose target is defined", () => {
		const result = validate(`
export const author = createTable("author", { id: c.id() })
export const post = createTable("post", { id: c.id(), author_id: c.ref("author_id").references(() => author.id) })
`)
		expect(result.errors).toEqual([])
	})

	it("warns about a table with no primary key", () => {
		const result = validate(`
export const note = createTable("note", { body: c.text("body") })
`)
		expect(result.warnings.join("\n")).toContain("no primary key detected")
	})

	it("warns about a repeated constraint name", () => {
		const result = validate(`
export const post = createTable("post", { id: c.id(), a: c.text("a"), b: c.text("b") }, (t) => [
	uniqueIndex("idx_dup").on(t.a),
	uniqueIndex("idx_dup").on(t.b),
])
`)
		expect(result.warnings.join("\n")).toContain('duplicate constraint name "idx_dup"')
	})

	it("ignores variable statements that are not table definitions", () => {
		const result = validate(`
export const notATable = { id: "x" }
export const alsoNot = someOtherCall("post", {})
export const post = createTable("post", { id: c.id() })
`)
		expect(result.errors).toEqual([])
	})

	it("ignores a table call with too few arguments to inspect", () => {
		const result = validate(`
export const post = createTable("post")
`)
		expect(result.errors).toEqual([])
	})

	it("accepts a composite primary key declared in the options", () => {
		const result = validate(`
import { primaryKey } from "drizzle-orm/sqlite-core"
export const post_tag = createTable("post_tag", { post_id: c.ref("post_id"), tag_id: c.ref("tag_id") }, (t) => [
	primaryKey({ columns: [t.post_id, t.tag_id] }),
])
`)
		expect(result.errors).toEqual([])
		expect(result.warnings.join("\n")).not.toContain("no primary key")
	})
})
