import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateConstraints } from "../../../../src/codegen/generators/constraints.ts"
import { generateTranslations } from "../../../../src/codegen/generators/translations.ts"

describe("generateTranslations", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-translations-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function setupConstraints(): string {
		const tablesFile = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			tablesFile,
			`
import { sqliteTable as createTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
	ref: (name: string) => text(name),
}
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
`,
		)
		const analysis = analyze(tablesFile)
		const constraintsPath = path.join(tmpDir, "db.test.constraints.gen.ts")
		generateConstraints(analysis.tables, "test", { output: constraintsPath }, tmpDir)
		return constraintsPath
	}

	it("generates error keys file from constraints", () => {
		const constraintsPath = setupConstraints()
		generateTranslations(constraintsPath, { baseDir: tmpDir }, tmpDir)

		const errorsFile = path.join(tmpDir, "db.test.error-keys.gen.ts")
		expect(fs.existsSync(errorsFile)).toBe(true)

		const content = fs.readFileSync(errorsFile, "utf-8")
		expect(content).toContain("TEST_DB_ERROR_KEYS")
		expect(content).toContain("type TestDbErrorKey")
	})

	it("generates EN translation file", () => {
		const constraintsPath = setupConstraints()
		generateTranslations(constraintsPath, { baseDir: tmpDir }, tmpDir)

		const translationFile = path.join(tmpDir, "translations", "error-keys", "db.test.error-keys.en.gen.ts")
		expect(fs.existsSync(translationFile)).toBe(true)

		const content = fs.readFileSync(translationFile, "utf-8")
		expect(content).toContain("TEST_DB_ERROR_KEYS_EN")
		expect(content).toContain("already exists")
	})

	it("derives human-readable messages from error keys", () => {
		const constraintsPath = setupConstraints()
		generateTranslations(constraintsPath, { baseDir: tmpDir }, tmpDir)

		const translationFile = path.join(tmpDir, "translations", "error-keys", "db.test.error-keys.en.gen.ts")
		const content = fs.readFileSync(translationFile, "utf-8")

		/* _duplicate keys -> "A record with this X already exists" */
		expect(content).toContain("already exists")
		/* _reference_not_found keys -> "Referenced record does not exist" */
		expect(content).toContain("Referenced record does not exist")
	})
})
