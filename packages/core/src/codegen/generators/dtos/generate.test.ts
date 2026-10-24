import { fixtureRoot } from "../../__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../analyzer.ts"
import { generateDtos } from "./generate.ts"
import { testContext } from "../__fixtures__/context.ts"

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-gen-dtos-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { force: true, recursive: true })
})

/** Write `schema` as the tables file, generate DTOs from it, and return the dtos directory. */
function generate(schema: string): string {
	const tablesPath = path.join(tmpDir, "db.test.tables.ts")
	fs.writeFileSync(tablesPath, schema)
	const dtosDir = path.join(tmpDir, "dtos")
	generateDtos(testContext(analyze(tablesPath), { cwd: tmpDir, tablesPath }), { output: dtosDir })
	return dtosDir
}

/** A generated entity file and the shared file, read from `dtosDir`. */
function read(dtosDir: string, entity: string): { all: string; entity: string; shared: string } {
	const entityContent = fs.readFileSync(path.join(dtosDir, entity, "index.gen.ts"), "utf-8")
	const shared = fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8")
	return { all: entityContent + shared, entity: entityContent, shared }
}

const basicSchema = `
import { sqliteTable as createTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
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

const readUser = () => read(generate(basicSchema), "user")

describe("generateDtos — files and schemas", () => {
	it("generates per-entity DTO files + shared file", () => {
		const dtosDir = generate(basicSchema)

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
		const { entity: content } = readUser()
		expect(content).toContain("userDtoReadSchema")
		expect(content).toContain("userDtoReadPartialSchema")
		expect(content).toContain("userDtoCreateSchema")
		expect(content).toContain("userDtoUpdateSchema")
	})

	it("applies email validation with transforms on create/update", () => {
		/* Schemas may be in entity or shared file (deduped) */
		const { all } = readUser()
		expect(all).toContain("z.email()")
		expect(all).toContain(".trim()")
		expect(all).toContain(".toLowerCase()")
	})

	it("applies max constraint to text fields", () => {
		expect(readUser().all).toContain(".max(100)")
	})

	it("generates TypeScript type exports", () => {
		const { entity: content } = readUser()
		expect(content).toContain("export type UserDtoRead =")
		expect(content).toContain("export type UserDtoCreate =")
		expect(content).toContain("export type UserDtoUpdate =")
	})
})

describe("generateDtos — keys and tables", () => {
	it("quotes a property key that is not an identifier (D6)", () => {
		const { entity } = read(
			generate(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const member = createTable("member", { id: c.id(), "display-name": c.text("display_name") })
`),
			"member",
		)
		expect(entity).toContain(`\t"display-name": `)
		expect(entity).not.toMatch(/^\tdisplay-name:/m)
	})

	it("handles multiple tables", () => {
		const dtosDir = generate(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const user = createTable("user", { id: c.id(), name: c.text("name") })
export const post = createTable("post", { id: c.id(), title: c.text("title") })
`)

		expect(fs.existsSync(path.join(dtosDir, "user", "index.gen.ts"))).toBe(true)
		expect(fs.existsSync(path.join(dtosDir, "post", "index.gen.ts"))).toBe(true)
	})
})

describe("generateDtos — timestamps and optionality", () => {
	it("generates timestamp spreads in shared file", () => {
		const { shared } = readUser()
		expect(shared).toContain("timestampsCreatedUpdatedDeletedReadSnakeCase")
		/* a create body takes no timestamp (F4) */
		expect(shared).not.toContain("timestampsCreatedUpdatedDeletedCreateSnakeCase")
	})

	it("uses timestamp spreads in entity files", () => {
		const { entity: content } = readUser()
		expect(content).toContain("...timestampsCreatedUpdatedDeletedReadSnakeCase")
		/* Should NOT have individual timestamp fields since they're spread */
		expect(content).not.toMatch(/\tcreated_at: timestampSchema/)
	})

	it("leaves the generated id out of the create schema, and makes nullable fields optional (D9)", () => {
		const { entity: content } = readUser()
		const createMatch = content.match(/userDtoCreateSchema[\s\S]*?^\}\)/m)
		expect(createMatch).toBeTruthy()
		const createBlock = createMatch?.[0] ?? ""
		expect(createBlock).not.toMatch(/^\tid:/m)
		expect(createBlock).toContain("name: _")
	})

	it("makes all fields optional in update schema", () => {
		const { entity: content, shared } = readUser()
		const updateMatch = content.match(/userDtoUpdateSchema[\s\S]*?^\}\)/m)
		expect(updateMatch).toBeTruthy()
		const updateBlock = updateMatch?.[0] ?? ""
		/* Every field in update is optional, inline or through the shared or local constant it names */
		const constants = `${shared}\n${content}`
		const optionalShared = new Set(
			[...constants.matchAll(/^(?:export )?const (_\w+) = .*\.optional\(\)/gm)].map((m) => m[1]),
		)
		const fieldLines = updateBlock.split("\n").filter((l) => /^\t\w+: /.test(l))
		expect(fieldLines.length).toBeGreaterThan(0)
		const notOptional = fieldLines.filter((line) => {
			const ref = /^\t\w+: (_\w+),$/.exec(line)?.[1]
			return !line.includes(".optional()") && !(ref !== undefined && optionalShared.has(ref))
		})
		expect(notOptional).toEqual([])
	})
})

const metaSchema = `
import { sqliteTable as createTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const item = createTable("item", {
	id: c.id("itm"),
	email: c.text("email", { min: 5, max: 254, email: true }).notNull(),
	website: c.text("website", { url: true, max: 2048 }),
	role: c.enum("role", ["admin", "member", "viewer"]).notNull(),
	score: c.integer("score", { min: 100, max: 1000 }),
	rating: c.real("rating"),
	active: c.boolean("active").notNull(),
	code: c.text("code", { min: 8, max: 8 }),
	label: c.text("label", { max: 50 }),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
})
`

const readItem = () => read(generate(metaSchema), "item")

describe("generateDtos — meta examples: shared", () => {
	it("emits shared meta object in shared file", () => {
		const { shared } = readItem()
		expect(shared).toContain("export const _m = {")
		expect(shared).toContain('email: { examples: ["user@example.com"] }')
		expect(shared).toContain('string: { examples: ["string"] }')
		expect(shared).toContain("boolean: { examples: [true] }")
		expect(shared).toContain("timestamp: { examples: [1711468800000] }")
	})

	it("uses shared _m.timestamp in timestampSchema", () => {
		expect(readItem().shared).toContain(".meta(_m.timestamp)")
	})

	it("imports _m from shared", () => {
		const { entity } = readItem()
		expect(entity).toContain("_m")
		expect(entity).toMatch(/import \{.*_m.*\} from "\.\.\/_shared\/index\.gen"/)
	})
})

describe("generateDtos — meta examples: per field", () => {
	it("includes email example in output", () => {
		expect(readItem().all).toContain(".meta(_m.email)")
	})

	it("includes url example in output", () => {
		expect(readItem().all).toContain(".meta(_m.url)")
	})

	it("adds prefixed ULID example on id fields (inline)", () => {
		expect(readItem().entity).toMatch(/\.meta\(\{ examples: \["itm_\w+"\] \}\)/)
	})

	it("includes boolean example in output", () => {
		expect(readItem().all).toContain(".meta(_m.boolean)")
	})

	it("includes first enum value as example", () => {
		expect(readItem().all).toContain('.meta({ examples: ["admin"] })')
	})

	it("includes integer midpoint example", () => {
		expect(readItem().all).toContain(".meta({ examples: [550] })")
	})

	it("includes real example in output", () => {
		expect(readItem().all).toContain(".meta(_m.real)")
	})

	it("adds exact-length string example", () => {
		expect(readItem().all).toContain('.meta({ examples: ["a1b2c3d4"] })')
	})

	it("includes generic string example in output", () => {
		expect(readItem().all).toContain(".meta(_m.string)")
	})
})

const dedupSchema = `
import { sqliteTable as createTable, text, integer } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
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

function generateDedup(): { alpha: string; beta: string; shared: string } {
	const dtosDir = generate(dedupSchema)
	return {
		alpha: fs.readFileSync(path.join(dtosDir, "alpha", "index.gen.ts"), "utf-8"),
		beta: fs.readFileSync(path.join(dtosDir, "beta", "index.gen.ts"), "utf-8"),
		shared: fs.readFileSync(path.join(dtosDir, "_shared", "index.gen.ts"), "utf-8"),
	}
}

describe("generateDtos — auto-dedup shared schemas", () => {
	it("emits _z* constants in shared file for repeated schemas", () => {
		const { shared } = generateDedup()
		/* the reference's text rules, shared across the three tables, base type aliased */
		expect(shared).toMatch(/export const _z_[0-9a-f]{8} = _str\b/)
	})

	it("entity files reference _z* instead of inline schemas", () => {
		const { alpha } = generateDedup()
		/* owner_id uses its shared schema, not an inline z.string() */
		expect(alpha).toMatch(/owner_id: _z_[0-9a-f]{8}/)
	})

	it("entity files import _z* constants from shared", () => {
		const { alpha } = generateDedup()
		expect(alpha).toMatch(/import \{.*_z_[0-9a-f]{8}.*\} from "\.\.\/_shared\/index\.gen"/)
	})

	it("does not dedup schemas with unique per-table values", () => {
		const { shared } = generateDedup()
		/* ID schemas with unique prefixes stay inline in entity files */
		expect(shared).not.toContain("alp_")
		expect(shared).not.toContain("bet_")
	})

	it("adds usage count comment to shared constants", () => {
		const { shared } = generateDedup()
		expect(shared).toMatch(/export const _z_[0-9a-f]{8} = .+ \/\* \d+x \*\//)
	})
})

/* the 0.12 review's F35: shared schemas numbered by use, so one column renumbered every table's file */
/** Three tables sharing schemas, `extra` added to the last one's columns */
const sharingTables = (extra: string) => `import { sqliteTable as createTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const book = createTable("book", { id: c.id("bok"), title: c.text("title").notNull(), note: c.text("note") })
export const shelf = createTable("shelf", { id: c.id("shf"), title: c.text("title").notNull(), note: c.text("note") })
export const author = createTable("author", { id: c.id("aut"), name: c.text("name").notNull()${extra} })
`

describe("generateDtos — shared schema names (F35)", () => {
	it("leave another table's DTO file unchanged when a column is added to one table", () => {
		const before = read(generate(sharingTables("")), "book").entity
		const after = read(
			generate(sharingTables(', a: c.integer("a"), b: c.integer("b"), d: c.integer("d"), e: c.integer("e")')),
			"book",
		).entity
		expect(after).toBe(before)
		expect(before).toMatch(/_z_[0-9a-f]{8}/)
	})
})
