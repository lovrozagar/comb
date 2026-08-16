import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateDtos } from "../../../../src/codegen/generators/dtos.ts"

describe("generateDtos", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-dtos-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTablesAndAnalyze(content: string): ReturnType<typeof analyze> {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, content)
		return analyze(fp)
	}

	const basicSchema = `
import { sqliteTable as createTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string, opts?: { min?: number, max?: number, email?: boolean, trim?: boolean, lowercase?: boolean }) => text(name),
	integer: (name: string) => integer(name, { mode: "number" }),
	boolean: (name: string) => integer(name, { mode: "boolean" }),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	updatedAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	deletedAt: (name: string) => integer(name, { mode: "number" }),
}
export const user = createTable("user", {
	id: c.id(),
	email: c.text("email", { min: 5, max: 254, email: true, trim: true, lowercase: true }).notNull(),
	name: c.text("name", { max: 100 }),
	age: c.integer("age"),
	is_active: c.boolean("is_active").notNull().default(false),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
	deleted_at: c.deletedAt("deleted_at"),
}, (t) => [
	uniqueIndex("idx_user_email").on(t.email),
])
`

	it("generates per-entity DTO files + shared file", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		/* Shared file */
		const sharedPath = path.join(dtosDir, "_shared", "index.gen.ts")
		expect(fs.existsSync(sharedPath)).toBe(true)
		const sharedContent = fs.readFileSync(sharedPath, "utf-8")
		expect(sharedContent).toContain("timestampSchema")

		/* Entity file */
		const userPath = path.join(dtosDir, "user", "index.gen.ts")
		expect(fs.existsSync(userPath)).toBe(true)
	})

	it("generates read, readPartial, create, update schemas", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		const content = fs.readFileSync(path.join(dtosDir, "user", "index.gen.ts"), "utf-8")
		expect(content).toContain("userDtoReadSchema")
		expect(content).toContain("userDtoReadPartialSchema")
		expect(content).toContain("userDtoCreateSchema")
		expect(content).toContain("userDtoUpdateSchema")
	})

	it("applies email validation with transforms on create/update", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		/* Schemas may be in entity or shared file (deduped) */
		const entity = fs.readFileSync(path.join(dtosDir, "user", "index.gen.ts"), "utf-8")
		const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
		const all = entity + shared
		expect(all).toContain("z.email()")
		expect(all).toContain(".trim()")
		expect(all).toContain(".toLowerCase()")
	})

	it("applies max constraint to text fields", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		const entity = fs.readFileSync(path.join(dtosDir, "user", "index.gen.ts"), "utf-8")
		const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
		const all = entity + shared
		expect(all).toContain(".max(100)")
	})

	it("generates timestamp spreads in shared file", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
		expect(shared).toContain("timestampsCreatedUpdatedDeletedReadSnakeCase")
		expect(shared).toContain("timestampsCreatedUpdatedDeletedCreateSnakeCase")
	})

	it("uses timestamp spreads in entity files", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		const content = fs.readFileSync(path.join(dtosDir, "user", "index.gen.ts"), "utf-8")
		expect(content).toContain("...timestampsCreatedUpdatedDeletedReadSnakeCase")
		/* Should NOT have individual timestamp fields since they're spread */
		expect(content).not.toMatch(/\tcreated_at: timestampSchema/)
	})

	it("generates TypeScript type exports", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		const content = fs.readFileSync(path.join(dtosDir, "user", "index.gen.ts"), "utf-8")
		expect(content).toContain("export type UserDtoRead =")
		expect(content).toContain("export type UserDtoCreate =")
		expect(content).toContain("export type UserDtoUpdate =")
	})

	it("makes id and nullable fields optional in create schema", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		const content = fs.readFileSync(path.join(dtosDir, "user", "index.gen.ts"), "utf-8")
		/* id should be optional in create */
		const createMatch = content.match(/userDtoCreateSchema[\s\S]*?^\}\)/m)
		expect(createMatch).toBeTruthy()
		const createBlock = createMatch?.[0] ?? ""
		expect(createBlock).toContain("id:")
		expect(createBlock).toContain(".optional()")
	})

	it("makes all fields optional in update schema", () => {
		const analysis = writeTablesAndAnalyze(basicSchema)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		const content = fs.readFileSync(path.join(dtosDir, "user", "index.gen.ts"), "utf-8")
		const updateMatch = content.match(/userDtoUpdateSchema[\s\S]*?^\}\)/m)
		expect(updateMatch).toBeTruthy()
		const updateBlock = updateMatch?.[0] ?? ""
		/* Every field in update should have .optional() */
		const fieldLines = updateBlock.split("\n").filter((l) => l.includes(":") && !l.includes("..."))
		for (const line of fieldLines) {
			if (line.includes("z.")) {
				expect(line).toContain(".optional()")
			}
		}
	})

	const metaSchema = `
import { sqliteTable as createTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core"
const c = {
	id: (prefix: string) => text("id").primaryKey(),
	text: (name: string, opts?: any) => text(name),
	integer: (name: string, opts?: any) => integer(name, { mode: "number" }),
	real: (name: string) => real(name),
	boolean: (name: string) => integer(name, { mode: "boolean" }),
	enum: (name: string, values: readonly string[]) => text(name),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	updatedAt: (name: string) => integer(name, { mode: "number" }).notNull(),
}
export const item = createTable("item", {
	id: c.id("itm"),
	email: c.text("email", { min: 5, max: 254, email: true }).notNull(),
	website: c.text("website", { url: true, max: 2048 }),
	role: c.enum("role", ["admin", "member", "viewer"]).notNull(),
	score: c.integer("score", { min: 0, max: 1000 }),
	rating: c.real("rating"),
	active: c.boolean("active").notNull(),
	code: c.text("code", { min: 6, max: 6 }),
	label: c.text("label", { max: 50 }),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
})
`

	describe("meta examples", () => {
		function generateAndRead(schema: string): { all: string; entity: string; shared: string } {
			const analysis = writeTablesAndAnalyze(schema)
			const tablesPath = path.join(tmpDir, "db.test.tables.ts")
			const dtosDir = path.join(tmpDir, "dtos")
			generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)
			const entityDir = path.join(dtosDir, "item")
			const entity = fs.readFileSync(path.join(entityDir, "index.gen.ts"), "utf-8")
			const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
			return { all: entity + shared, entity, shared }
		}

		it("emits shared meta object in shared file", () => {
			const { shared } = generateAndRead(metaSchema)
			expect(shared).toContain("export const _m = {")
			expect(shared).toContain('email: { examples: ["user@example.com"] }')
			expect(shared).toContain('string: { examples: ["string"] }')
			expect(shared).toContain("boolean: { examples: [true] }")
			expect(shared).toContain("timestamp: { examples: [1711468800000] }")
		})

		it("includes email example in output", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toContain(".meta(_m.email)")
		})

		it("includes url example in output", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toContain(".meta(_m.url)")
		})

		it("adds prefixed ULID example on id fields (inline)", () => {
			const { entity } = generateAndRead(metaSchema)
			expect(entity).toMatch(/\.meta\(\{ examples: \["itm_\w+"\] \}\)/)
		})

		it("includes boolean example in output", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toContain(".meta(_m.boolean)")
		})

		it("includes first enum value as example", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toContain('.meta({ examples: ["admin"] })')
		})

		it("includes integer midpoint example", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toContain(".meta({ examples: [500] })")
		})

		it("includes real example in output", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toContain(".meta(_m.real)")
		})

		it("adds exact-length string example", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toMatch(/\.meta\(\{ examples: \["\w{6}"\] \}\)/)
		})

		it("includes generic string example in output", () => {
			const { all } = generateAndRead(metaSchema)
			expect(all).toContain(".meta(_m.string)")
		})

		it("uses shared _m.timestamp in timestampSchema", () => {
			const { shared } = generateAndRead(metaSchema)
			expect(shared).toContain(".meta(_m.timestamp)")
		})

		it("imports _m from shared", () => {
			const { entity } = generateAndRead(metaSchema)
			expect(entity).toContain("_m")
			expect(entity).toMatch(/import \{.*_m.*\} from "\.\.\/_shared\/index\.gen"/)
		})
	})

	it("handles multiple tables", () => {
		const analysis = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	text: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id(), name: c.text("name") })
export const post = createTable("post", { id: c.id(), title: c.text("title") })
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const dtosDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

		expect(fs.existsSync(path.join(dtosDir, "user", "index.gen.ts"))).toBe(true)
		expect(fs.existsSync(path.join(dtosDir, "post", "index.gen.ts"))).toBe(true)
	})

	describe("auto-dedup shared schemas", () => {
		const dedupSchema = `
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
const c = {
	id: (prefix: string) => text("id").primaryKey(),
	text: (name: string, opts?: any) => text(name),
	ref: (name: string) => text(name),
	boolean: (name: string) => integer(name, { mode: "boolean" }),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
}
export const alpha = createTable("alpha", {
	id: c.id("alp"),
	owner_id: c.ref("owner_id").notNull(),
	tag_id: c.ref("tag_id"),
	active: c.boolean("active").notNull(),
	created_at: c.createdAt("created_at"),
})
export const beta = createTable("beta", {
	id: c.id("bet"),
	owner_id: c.ref("owner_id").notNull(),
	tag_id: c.ref("tag_id"),
	active: c.boolean("active").notNull(),
	created_at: c.createdAt("created_at"),
})
export const gamma = createTable("gamma", {
	id: c.id("gam"),
	owner_id: c.ref("owner_id").notNull(),
	tag_id: c.ref("tag_id"),
	active: c.boolean("active").notNull(),
	created_at: c.createdAt("created_at"),
})
`

		function generateDedup() {
			const analysis = writeTablesAndAnalyze(dedupSchema)
			const tablesPath = path.join(tmpDir, "db.test.tables.ts")
			const dtosDir = path.join(tmpDir, "dtos")
			generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)
			return {
				alpha: fs.readFileSync(path.join(dtosDir, "alpha", "index.gen.ts"), "utf-8"),
				beta: fs.readFileSync(path.join(dtosDir, "beta", "index.gen.ts"), "utf-8"),
				shared: fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8"),
			}
		}

		it("emits _z* constants in shared file for repeated schemas", () => {
			const { shared } = generateDedup()
			/* FK ref _str.min(1).max(48) — base type aliased */
			expect(shared).toMatch(/export const _z\d+ = _str\.min\(1\)\.max\(48\)/)
		})

		it("entity files reference _z* instead of inline schemas", () => {
			const { alpha } = generateDedup()
			/* owner_id (FK ref) should use _z* ref, not inline z.string().min(1).max(48) */
			expect(alpha).toMatch(/owner_id: _z\d+/)
		})

		it("entity files import _z* constants from shared", () => {
			const { alpha } = generateDedup()
			expect(alpha).toMatch(/import \{.*_z\d+.*\} from "\.\.\/_shared\/index\.gen"/)
		})

		it("does not dedup schemas with unique per-table values", () => {
			const { shared } = generateDedup()
			/* ID schemas with unique prefixes stay inline in entity files */
			expect(shared).not.toContain("alp_")
			expect(shared).not.toContain("bet_")
		})

		it("adds usage count comment to shared constants", () => {
			const { shared } = generateDedup()
			expect(shared).toMatch(/export const _z\d+ = .+ \/\* \d+x \*\//)
		})
	})

	describe("relative enum imports", () => {
		function writeEnumAndTables() {
			/* Write enum file alongside tables */
			const enumContent = `export const STATUS_ENUM = ["active", "inactive", "archived"] as const\n`
			fs.writeFileSync(path.join(tmpDir, "enums.ts"), enumContent)

			const tablesContent = `
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
import { STATUS_ENUM } from "./enums"
const c = {
	id: (prefix: string) => text("id").primaryKey(),
	text: (name: string, opts?: any) => text(name),
	enum: (name: string, values: readonly string[]) => text(name),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
}
export const item = createTable("item", {
	id: c.id("itm"),
	status: c.enum("status", STATUS_ENUM).notNull(),
	label: c.text("label", { max: 100 }),
	created_at: c.createdAt("created_at"),
})
`
			const fp = path.join(tmpDir, "db.test.tables.ts")
			fs.writeFileSync(fp, tablesContent)
			return analyze(fp)
		}

		it("preserves relative import path in generated DTO", () => {
			const analysis = writeEnumAndTables()
			const tablesPath = path.join(tmpDir, "db.test.tables.ts")
			const dtosDir = path.join(tmpDir, "dtos")
			generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

			const entity = fs.readFileSync(path.join(dtosDir, "item", "index.gen.ts"), "utf-8")
			/* Import should use relative path from the original import */
			expect(entity).toContain('import { STATUS_ENUM } from "./enums"')
		})

		it("enum schemas stay inline (not shared) due to external identifier", () => {
			const analysis = writeEnumAndTables()
			const tablesPath = path.join(tmpDir, "db.test.tables.ts")
			const dtosDir = path.join(tmpDir, "dtos")
			generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

			const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
			/* Shared file must NOT contain the enum ref */
			expect(shared).not.toContain("STATUS_ENUM")
		})

		it("uses intra-entity local const for repeated enum", () => {
			const analysis = writeEnumAndTables()
			const tablesPath = path.join(tmpDir, "db.test.tables.ts")
			const dtosDir = path.join(tmpDir, "dtos")
			generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

			const entity = fs.readFileSync(path.join(dtosDir, "item", "index.gen.ts"), "utf-8")
			/* Enum appears 4x (read, readPartial, create, update) → should get local _l* const */
			expect(entity).toMatch(/const _l\d+ = z\.enum\(STATUS_ENUM\)/)
		})

		it("works with lowercase enum const names", () => {
			/* Write enum file with camelCase name */
			fs.writeFileSync(path.join(tmpDir, "enums.ts"), `export const statusValues = ["active", "inactive"] as const\n`)
			const tablesContent = `
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
import { statusValues } from "./enums"
const c = {
	id: (prefix: string) => text("id").primaryKey(),
	enum: (name: string, values: readonly string[]) => text(name),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
}
export const thing = createTable("thing", {
	id: c.id("tng"),
	status: c.enum("status", statusValues).notNull(),
	created_at: c.createdAt("created_at"),
})
`
			const fp = path.join(tmpDir, "db.test.tables.ts")
			fs.writeFileSync(fp, tablesContent)
			const analysis = analyze(fp)
			const dtosDir = path.join(tmpDir, "dtos")
			generateDtos(analysis, fp, { output: dtosDir }, tmpDir)

			const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
			const entity = fs.readFileSync(path.join(dtosDir, "thing", "index.gen.ts"), "utf-8")
			/* Lowercase enum must NOT leak into shared file */
			expect(shared).not.toContain("statusValues")
			/* Entity must import and use it */
			expect(entity).toContain('import { statusValues } from "./enums"')
			expect(entity).toContain("z.enum(statusValues)")
		})

		it("generates correct z.enum() with imported const", () => {
			const analysis = writeEnumAndTables()
			const tablesPath = path.join(tmpDir, "db.test.tables.ts")
			const dtosDir = path.join(tmpDir, "dtos")
			generateDtos(analysis, tablesPath, { output: dtosDir }, tmpDir)

			const entity = fs.readFileSync(path.join(dtosDir, "item", "index.gen.ts"), "utf-8")
			const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
			const all = entity + shared
			expect(all).toContain("z.enum(STATUS_ENUM)")
		})
	})
})
