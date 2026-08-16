import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateConstraints } from "../../../../src/codegen/generators/constraints.ts"

describe("generateConstraints", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-constraints-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTablesAndAnalyze(content: string): ReturnType<typeof analyze> {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, content)
		return analyze(fp)
	}

	it("generates constraint map with primary key", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey() }
export const user = createTable("user", { id: c.id() })
`)
		const outputPath = path.join(tmpDir, "constraints.gen.ts")
		generateConstraints(result.tables, "test", { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("TEST_DB_CONSTRAINT_MAP")
		expect(content).toContain("primaryKey")
		expect(content).toContain("user_id_duplicate")
	})

	it("generates unique constraints from indexes", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
}
export const user = createTable("user", {
	id: c.id(),
	email: c.text("email").notNull(),
}, (t) => [
	uniqueIndex("idx_user_email").on(t.email),
])
`)
		const outputPath = path.join(tmpDir, "constraints.gen.ts")
		generateConstraints(result.tables, "test", { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("unique")
		expect(content).toContain("user_email_duplicate")
	})

	it("generates FK constraints", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id() })
export const post = createTable("post", {
	id: c.id(),
	user_id: c.ref("user_id").references(() => user.id).notNull(),
})
`)
		const outputPath = path.join(tmpDir, "constraints.gen.ts")
		generateConstraints(result.tables, "test", { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("foreignKey")
		expect(content).toContain("post_user_id_reference_not_found")
	})

	it("generates check constraints", () => {
		const result = writeTablesAndAnalyze(`
import { sql } from "drizzle-orm"
import { sqliteTable as createTable, text, integer, check } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	integer: (name: string) => integer(name, { mode: "number" }),
}
export const item = createTable("item", {
	id: c.id(),
	price: c.integer("price").notNull(),
}, (t) => [
	check("price_positive", sql\`price > 0\`),
])
`)
		const outputPath = path.join(tmpDir, "constraints.gen.ts")
		generateConstraints(result.tables, "test", { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("check")
		expect(content).toContain("item_price_positive_failed")
	})

	it("generates no output for tables without constraints", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { text: (name: string) => text(name) }
export const log = createTable("log", { msg: c.text("msg") })
`)
		const outputPath = path.join(tmpDir, "constraints.gen.ts")
		generateConstraints(result.tables, "test", { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("TEST_DB_CONSTRAINT_MAP")
		/* No table entries since no PK, FK, unique, or check */
		expect(content).not.toContain("log:")
	})
})

describe("generateConstraints — check-constraint classification", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-constraints-checks-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function generateFor(checkName: string, expression = "length(x) <= 10"): string {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`
import { sqliteTable as createTable, text, check } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
const c = { id: () => text("id").primaryKey(), text: (name: string) => text(name) }
export const doc = createTable("doc", { id: c.id(), x: c.text("x") }, (t) => [
	check("${checkName}", sql\`${expression}\`),
])
`,
		)
		const analysis = analyze(fp)
		const outputPath = path.join(tmpDir, "constraints.gen.ts")
		generateConstraints(analysis.tables, "test", { output: outputPath }, tmpDir)
		return fs.readFileSync(outputPath, "utf-8")
	}

	it("reads an _enum check as an invalid enum value, at 400", () => {
		const content = generateFor("doc_status_enum")
		expect(content).toContain("Invalid enum value")
		expect(content).toContain("bad_request")
	})

	it("turns a _size check into a human byte limit", () => {
		const content = generateFor("doc_body_size", "length(x) <= 2048")
		expect(content).toContain("Exceeds maximum size of 2KB")
		expect(content).toContain("bad_request")
	})

	it("keeps the generic size message when no limit can be read", () => {
		const content = generateFor("doc_body_size", "length(x) > 0")
		expect(content).toContain("Check constraint violated")
	})

	it("reads expiry and valid checks as date constraints", () => {
		expect(generateFor("doc_expiry_check")).toContain("Invalid date/time constraint")
		expect(generateFor("doc_valid_range")).toContain("Invalid date/time constraint")
	})

	it("reads an integrity check as a data integrity failure, staying at conflict", () => {
		const content = generateFor("doc_integrity_check")
		expect(content).toContain("Data integrity constraint violated")
	})

	it("falls back to the generic message and conflict for an unclassified check", () => {
		const content = generateFor("doc_something_else")
		expect(content).toContain("Check constraint violated")
		expect(content).toContain("conflict")
	})
})

describe("generateConstraints — column-level unique", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-constraints-unique-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	it("maps a .unique() column as well as a uniqueIndex", () => {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey(), text: (name: string) => text(name) }
export const user = createTable("user", { id: c.id(), email: c.text("email").unique() })
`,
		)
		const analysis = analyze(fp)
		const outputPath = path.join(tmpDir, "constraints.gen.ts")
		generateConstraints(analysis.tables, "test", { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("user_email_duplicate")
		expect(content).toContain("conflict")
	})
})
