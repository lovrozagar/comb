import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FieldMeta, TableMeta } from "../../../../src/codegen/analyzer-types.ts"
import { generateEnumChecks } from "../../../../src/codegen/generators/enum-checks.ts"

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

describe("generateEnumChecks", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-enum-checks-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	it("generates check functions for tables with enum fields", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [
					makeField({ isPrimaryKey: true, name: "id" }),
					makeField({ enumValues: ["admin", "user", "guest"], name: "role" }),
				],
				sqlName: "users",
				varName: "users",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		generateEnumChecks(tables, "core", { output }, tmpDir)

		const content = fs.readFileSync(output, "utf-8")
		expect(content).toContain("usersEnumChecks")
		expect(content).toContain("users_role_enum")
		expect(content).toContain("'admin', 'user', 'guest'")
		expect(content).toContain('import { check } from "drizzle-orm/sqlite-core"')
		expect(content).toContain('import { sql } from "drizzle-orm"')
	})

	it("skips tables with no enum fields", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [makeField({ isPrimaryKey: true, name: "id" }), makeField({ name: "name" })],
				sqlName: "users",
				varName: "users",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		generateEnumChecks(tables, "core", { output }, tmpDir)
		consoleSpy.mockRestore()

		expect(fs.existsSync(output)).toBe(false)
	})

	it("handles multiple enum fields per table", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [
					makeField({ enumValues: ["admin", "user"], name: "role" }),
					makeField({ enumValues: ["active", "inactive"], name: "status" }),
				],
				sqlName: "users",
				varName: "users",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		generateEnumChecks(tables, "core", { output }, tmpDir)

		const content = fs.readFileSync(output, "utf-8")
		expect(content).toContain("users_role_enum")
		expect(content).toContain("users_status_enum")
		expect(content).toContain("'admin', 'user'")
		expect(content).toContain("'active', 'inactive'")
	})

	it("handles multiple tables", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [makeField({ enumValues: ["admin", "user"], name: "role" })],
				sqlName: "users",
				varName: "users",
			}),
			makeTable({
				fields: [makeField({ enumValues: ["draft", "published"], name: "status" })],
				sqlName: "posts",
				varName: "posts",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		generateEnumChecks(tables, "core", { output }, tmpDir)

		const content = fs.readFileSync(output, "utf-8")
		expect(content).toContain("usersEnumChecks")
		expect(content).toContain("postsEnumChecks")
	})

	it("escapes single quotes in enum values", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [makeField({ enumValues: ["it's", "won't"], name: "label" })],
				sqlName: "items",
				varName: "items",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		generateEnumChecks(tables, "core", { output }, tmpDir)

		const content = fs.readFileSync(output, "utf-8")
		expect(content).toContain("it''s")
		expect(content).toContain("won''t")
	})

	it("converts snake_case varName to camelCase for function name", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [makeField({ enumValues: ["a", "b"], name: "type" })],
				sqlName: "user_accounts",
				varName: "user_accounts",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		generateEnumChecks(tables, "core", { output }, tmpDir)

		const content = fs.readFileSync(output, "utf-8")
		expect(content).toContain("userAccountsEnumChecks")
	})

	it("ignores fields with null enumValues", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [
					makeField({ enumName: "MyEnum", enumValues: null, name: "role" }),
					makeField({ enumValues: ["a"], name: "status" }),
				],
				sqlName: "users",
				varName: "users",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		generateEnumChecks(tables, "core", { output }, tmpDir)

		const content = fs.readFileSync(output, "utf-8")
		expect(content).not.toContain("users_role_enum")
		expect(content).toContain("users_status_enum")
	})

	it("ignores fields with empty enumValues array", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [makeField({ enumValues: [], name: "role" })],
				sqlName: "users",
				varName: "users",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})
		generateEnumChecks(tables, "core", { output }, tmpDir)
		consoleSpy.mockRestore()

		expect(fs.existsSync(output)).toBe(false)
	})

	it("includes auto-generated header comment", () => {
		const tables: TableMeta[] = [
			makeTable({
				fields: [makeField({ enumValues: ["x"], name: "t" })],
				sqlName: "t",
				varName: "t",
			}),
		]
		const output = path.join(tmpDir, "enum-checks.gen.ts")

		generateEnumChecks(tables, "core", { output }, tmpDir)

		const content = fs.readFileSync(output, "utf-8")
		expect(content).toContain("@generated by comb")
		expect(content).toContain("do not edit")
	})
})
