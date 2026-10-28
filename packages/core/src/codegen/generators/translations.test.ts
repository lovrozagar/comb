import { fixtureRoot } from "../__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateConstraints } from "./constraints.ts"
import { generateTranslations } from "./translations.ts"
import { type TestContext, testContext } from "./__fixtures__/context.ts"

const TABLES = `
import { sqliteTable as createTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const user = createTable("user", {
	id: c.id(),
	email: c.text("email").notNull(),
}, (t) => [
	uniqueIndex("idx_user_email").on(t.email),
])
export const post = createTable("post", {
	id: c.id(),
	user_id: c.ref("user_id").references(() => user.id).notNull(),
})
`

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-gen-translations-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { force: true, recursive: true })
})

/** Translations from a tables file holding `body`, under the file prefix the CLI uses */
function fromTables(body = TABLES): TestContext {
	const tablesFile = path.join(tmpDir, "db.test.tables.ts")
	fs.writeFileSync(tablesFile, body)
	const ctx = testContext(analyze(tablesFile), { cwd: tmpDir })
	generateTranslations(ctx, { baseDir: tmpDir, filePrefix: "db.test" })
	return ctx
}

const read = (...parts: string[]) => fs.readFileSync(path.join(tmpDir, ...parts), "utf-8")
const english = (prefix: string) => read("translations", "error-keys", `${prefix}.error-keys.en.gen.ts`)

const HEAD = `import { sql } from "drizzle-orm"
import { check, sqliteTable as createTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
`

describe("generateTranslations", () => {
	it("writes the error keys file and an en-US translation for every key the constraint map declares", () => {
		const ctx = fromTables()

		const keys = read("db.test.error-keys.gen.ts")
		expect(keys).toContain("TEST_DB_ERROR_KEYS")
		expect(keys).toContain("type TestDbErrorKey")
		const en = english("db.test")
		expect(en).toContain('import type { TEST_DB_ERROR_KEYS } from "../../db.test.error-keys.gen"')
		expect(en).toContain("TEST_DB_ERROR_KEYS_EN")
		expect(en).toContain('user_email_duplicate: "A record with this email already exists"')
		expect(en).toContain('user_id_duplicate: "Record with this ID already exists"')
		expect(en).toContain('post_user_id_reference_not_found: "Referenced record does not exist"')
		expect(ctx.logged).toEqual(["Generated error translations for test database", "Error keys: 4"])
	})

	it("declares exactly the keys the constraints generator writes", () => {
		fromTables()
		const constraintsPath = path.join(tmpDir, "db.test.constraints.gen.ts")
		generateConstraints(testContext(analyze(path.join(tmpDir, "db.test.tables.ts")), { cwd: tmpDir }), {
			output: constraintsPath,
		})
		const inMap = [...read("db.test.constraints.gen.ts").matchAll(/errorKey: "([^"]+)"/g)].map((m) => m[1]).sort()
		const inKeys = [...read("db.test.error-keys.gen.ts").matchAll(/^\t(\w+): /gm)].map((m) => m[1])
		expect(inKeys).toEqual(inMap)
	})

	it("names a multi-word unique column in full, as its constraint's cause does", () => {
		fromTables(`${HEAD}export const doc = createTable("doc", { id: text("id").primaryKey(), created_by: text("created_by") }, (t) => [
	uniqueIndex("doc_created_by_unique").on(t.created_by),
])
`)
		expect(english("db.test")).toContain('doc_created_by_duplicate: "A record with this created by already exists"')
	})

	it("names a size CHECK by its cause, and quotes keys that are not identifiers", () => {
		fromTables(`${HEAD}export const auditLog = createTable("audit-log", { body: text("body") }, () => [
	check("body_size", sql\`length(body) <= 2048\`),
])
`)
		const en = english("db.test")
		expect(en).toContain('"audit-log_body_size_failed": "Exceeds maximum size of 2KB"')
		expect(read("db.test.error-keys.gen.ts")).toContain('"audit-log_body_size_failed": "audit-log_body_size_failed"')
	})

	it("warns and writes nothing when no constraint declares an error key", () => {
		const ctx = fromTables(`${HEAD}export const note = createTable("note", { body: text("body") })\n`)
		expect(ctx.warned).toEqual(["Warning: no constraint declares an error key; translations skipped"])
		expect(fs.existsSync(path.join(tmpDir, "db.test.error-keys.gen.ts"))).toBe(false)
	})
})

describe("generateTranslations — composite uniques", () => {
	it("names a composite unique's columns together, never as an ID (C3)", () => {
		fromTables(`${HEAD}export const account = createTable("account", { id: text("id").primaryKey(), provider: text("provider"), account_id: text("account_id") }, (t) => [
	uniqueIndex("account_provider_account").on(t.provider, t.account_id),
])
`)
		expect(english("db.test")).toContain(
			'account_provider_account_id_duplicate: "A record with this provider and account id combination already exists"',
		)
	})
})

/* the 0.12 review's F34: a 400 no retry fixes was told to try again */
describe("generateTranslations: a CHECK and an enum key (F34)", () => {
	it("says what the value broke, never to try again", () => {
		fromTables(`import { sql } from "drizzle-orm"
import { check, sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const seat = sqliteTable("seat", { id: c.id("set"), kind: c.enum("kind", ["a", "b"]), n: c.integer("n"), note: c.text("note") }, (t) => [
	check("seat_n_positive", sql\`\${t.n} > 0\`),
	check("seat_note_size", sql\`length(\${t.note}) <= 2048\`),
])
`)
		const en = english("db.test")
		expect(en).toContain('seat_kind_enum_invalid: "This value is not one of the allowed values"')
		expect(en).toContain('seat_n_positive_failed: "This value breaks a rule of the record"')
		expect(en).toContain('seat_note_size_failed: "Exceeds maximum size of 2KB"')
		expect(en).not.toContain("Please try again")
	})
})

/* G2 of plan 14: the table-level keys F66 gives a private column's constraints, in English */
describe("generateTranslations: a private column's keys (F66)", () => {
	it("says each kind's generic cause, never another's", () => {
		fromTables(`import { sql } from "drizzle-orm"
import { check, sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const user = sqliteTable("user", { id: c.id("usr") })
export const doc = sqliteTable("doc", {
	id: c.id("doc"),
	secret: c.text("secret", { private: true }).unique(),
	_owner: c.ref("owner").references(() => user.id),
	_kind: c.enum("kind", ["a", "b"]),
}, (t) => [check("doc_secret_len", sql\`length(\${t.secret}) < 64\`)])
`)
		const en = english("db.test")
		expect(en).toContain('doc_duplicate: "A record with these values already exists"')
		expect(en).toContain('doc_reference_not_found: "Referenced record does not exist"')
		expect(en).toContain('doc_value_invalid: "This value is not one of the allowed values"')
		expect(en).toContain('doc_check_failed: "This value breaks a rule of the record"')
	})
})
