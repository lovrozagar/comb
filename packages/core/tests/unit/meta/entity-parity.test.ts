/**
 * The published entity facts must match the analyzer's view of the table, and
 * the DTOs generated from that same view.
 *
 * The strongest assertion here is the last one: `immutable` is checked against
 * the fields actually absent from the generated update schema, not against a
 * restatement of the rule.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../src/codegen/analyzer.ts"
import { deriveEntityMeta } from "../../../src/codegen/entity-meta.ts"
import { generateDtos } from "../../../src/codegen/generators/dtos.ts"
import { validateTables } from "../../../src/codegen/utils/validate.ts"

const PRELUDE = `
import { sqliteTable as createTable, text, integer, primaryKey, uniqueIndex } from "drizzle-orm/sqlite-core"
const c = {
	id: (_p: string) => text("id").primaryKey(),
	serialId: () => integer("id").primaryKey({ autoIncrement: true }),
	text: (name: string, _o?: { max?: number; nomutate?: boolean; private?: boolean }) => text(name),
	enum: (name: string, _v: readonly string[], _s?: object) => text(name),
	ref: (name: string, _o?: { tenant?: boolean }) => text(name),
	createdAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	updatedAt: (name: string) => integer(name, { mode: "number" }).notNull(),
	deletedAt: (name: string) => integer(name, { mode: "number" }),
}
`

describe("entity meta matches the analyzer", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-meta-entity-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function analyzeSource(source: string) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + source)
		return { analysis: analyze(fp), tablesPath: fp }
	}

	const fullTable = `
export const post = createTable("post", {
	id: c.id("pst"),
	title: c.text("title", { max: 200 }),
	slug: c.text("slug", { nomutate: true }),
	author_id: c.ref("author_id"),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
	deleted_at: c.deletedAt("deleted_at"),
})
`

	it("names the entity by its SQL table name, not the variable", () => {
		const { analysis } = analyzeSource(`
export const blogPost = createTable("blog_post", { id: c.id("bp") })
`)
		expect(deriveEntityMeta(analysis.tables[0]!)?.name).toBe("blog_post")
	})

	it("takes identity from the primary key the analyzer found", () => {
		const { analysis } = analyzeSource(fullTable)
		const table = analysis.tables[0]!
		const meta = deriveEntityMeta(table)!

		expect(meta.identity).toBe(table.fields.find((f) => f.isPrimaryKey)!.name)
		expect(meta.identity).toBe("id")
	})

	it("reports the tombstone column only when the table has one", () => {
		const { analysis: withSoft } = analyzeSource(fullTable)
		expect(deriveEntityMeta(withSoft.tables[0]!)?.softDelete).toBe("deleted_at")

		const { analysis: hard } = analyzeSource(`
export const tag = createTable("tag", { id: c.id("tag"), name: c.text("name") })
`)
		expect(deriveEntityMeta(hard.tables[0]!)?.softDelete).toBeNull()
	})

	it("lists every autogenerate field as generated, plus the identity", () => {
		const { analysis } = analyzeSource(fullTable)
		const table = analysis.tables[0]!
		const meta = deriveEntityMeta(table)!

		for (const field of table.fields) {
			if (field.constraints.autogenerate) {
				expect(meta.generated, `autogenerate field missing from generated: ${field.name}`).toContain(field.name)
			}
		}
		expect(meta.generated).toContain("id")
	})

	it("omits the stamp entirely for a composite primary key", () => {
		const { analysis } = analyzeSource(`
export const post_tag = createTable("post_tag", {
	post_id: c.ref("post_id"),
	tag_id: c.ref("tag_id"),
}, (t) => [primaryKey({ columns: [t.post_id, t.tag_id] })])
`)
		/* No single identity to publish, and picking one would be a guess. */
		expect(deriveEntityMeta(analysis.tables[0]!)).toBeNull()
	})

	it("declares immutable exactly as the fields absent from the update DTO", () => {
		const { analysis, tablesPath } = analyzeSource(fullTable)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, tablesPath, { output: outDir }, tmpDir)

		const generated = fs.readFileSync(path.join(outDir, "post", "index.gen.ts"), "utf-8")
		const updateBlock = generated.match(/postDtoUpdateSchema = z\.object\(\{([\s\S]*?)\n\}\)/)?.[1] ?? ""
		const inUpdate = new Set([...updateBlock.matchAll(/^\t(\w+):/gm)].map((m) => m[1]!))

		const table = analysis.tables[0]!
		const meta = deriveEntityMeta(table)!

		/* Every published-immutable field is missing from the update body … */
		for (const field of meta.immutable) {
			expect(inUpdate.has(field), `published immutable but present in update DTO: ${field}`).toBe(false)
		}
		/* … and every field missing from the update body is published immutable.
		   Both directions, so neither list can quietly grow past the other. */
		for (const field of table.fields) {
			if (!inUpdate.has(field.name)) {
				expect(meta.immutable, `absent from update DTO but not published immutable: ${field.name}`).toContain(
					field.name,
				)
			}
		}
	})

	it("stamps the read schema and only the read schema", () => {
		const { analysis, tablesPath } = analyzeSource(fullTable)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, tablesPath, { output: outDir }, tmpDir)

		const generated = fs.readFileSync(path.join(outDir, "post", "index.gen.ts"), "utf-8")
		expect(generated).toContain(`import { combMeta } from "@lovrozagar/comb/meta"`)
		expect(generated.match(/combMeta\(\{/g)).toHaveLength(1)
		expect(generated).toMatch(/postDtoReadSchema = z\.object\(\{[\s\S]*?\}\)\.meta\(combMeta\(\{/)
	})

	it("emits no stamp and no import when no table has a single identity", () => {
		const { analysis, tablesPath } = analyzeSource(`
export const post_tag = createTable("post_tag", {
	post_id: c.ref("post_id"),
	tag_id: c.ref("tag_id"),
}, (t) => [primaryKey({ columns: [t.post_id, t.tag_id] })])
`)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, tablesPath, { output: outDir }, tmpDir)

		const generated = fs.readFileSync(path.join(outDir, "post_tag", "index.gen.ts"), "utf-8")
		expect(generated).not.toContain("combMeta")
	})

	it("honours a custom importFrom, as the entities generator does", () => {
		const { analysis, tablesPath } = analyzeSource(fullTable)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, tablesPath, { importFrom: "@acme/db", output: outDir }, tmpDir)

		const generated = fs.readFileSync(path.join(outDir, "post", "index.gen.ts"), "utf-8")
		expect(generated).toContain(`import { combMeta } from "@acme/db/meta"`)
	})

	it("regenerates byte-identically, so the checksum header does not churn", () => {
		const { analysis, tablesPath } = analyzeSource(fullTable)
		const outDir = path.join(tmpDir, "dtos")

		generateDtos(analysis, tablesPath, { output: outDir }, tmpDir)
		const first = fs.readFileSync(path.join(outDir, "post", "index.gen.ts"), "utf-8")
		generateDtos(analysis, tablesPath, { output: outDir }, tmpDir)
		const second = fs.readFileSync(path.join(outDir, "post", "index.gen.ts"), "utf-8")

		expect(second).toBe(first)
	})
})

describe("a mismatch fails loudly", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-meta-validate-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function validateSource(source: string) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + source)
		return validateTables(fp)
	}

	it("warns, but does not block codegen, when the primary key is not the tiebreak column", () => {
		/* Plenty of tables are never listed — join tables, lookup maps, comb's own
		   shard_map. Blocking codegen for those would force a rename of a column
		   that is named correctly. The exact guarantee lives in buildListQuery. */
		const result = validateSource(`
export const post = createTable("post", {
	pk: c.id("pst"),
	title: c.text("title"),
})
`)
		expect(result.errors).toEqual([])
		expect(result.warnings.join("\n")).toMatch(/primary key is declared as "pk"/)
		expect(result.warnings.join("\n")).toContain("cannot be")
	})

	it("accepts the conventional shape without complaint", () => {
		const result = validateSource(`
export const post = createTable("post", {
	id: c.id("pst"),
	title: c.text("title"),
})
`)
		expect(result.errors).toEqual([])
	})

	it("does not apply the rule to a composite primary key", () => {
		const result = validateSource(`
export const post_tag = createTable("post_tag", {
	post_id: c.ref("post_id"),
	tag_id: c.ref("tag_id"),
}, (t) => [primaryKey({ columns: [t.post_id, t.tag_id] })])
`)
		expect(result.errors).toEqual([])
	})
})

describe("tenantColumn is declared, never inferred", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-tenant-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function metaFor(body: string) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + body)
		const analysis = analyze(fp)
		return deriveEntityMeta(analysis.tables.find((t) => t.sqlName === "post")!)
	}

	it("reports the column a table declares", () => {
		expect(
			metaFor(`
export const post = createTable("post", {
	id: c.id("pst"),
	org_id: c.ref("org_id", { tenant: true }),
	title: c.text("title"),
})
`)?.tenantColumn,
		).toBe("org_id")
	})

	it("stays null for a foreign key that merely looks tenant-ish", () => {
		/* org_id is a plain FK here. Guessing from the name would reproduce a
		   consumer's own fallback heuristic and dress it up as a declaration. */
		expect(
			metaFor(`
export const org = createTable("org", { id: c.id("org") })
export const post = createTable("post", {
	id: c.id("pst"),
	org_id: c.ref("org_id").references(() => org.id),
})
`)?.tenantColumn,
		).toBeNull()
	})

	it("stays null when nothing is declared", () => {
		expect(metaFor(`export const post = createTable("post", { id: c.id("pst") })`)?.tenantColumn).toBeNull()
	})

	it("drops the fact rather than choosing when two columns declare it", () => {
		expect(
			metaFor(`
export const post = createTable("post", {
	id: c.id("pst"),
	org_id: c.ref("org_id", { tenant: true }),
	workspace_id: c.ref("workspace_id", { tenant: true }),
})
`)?.tenantColumn,
		).toBeNull()
	})

	it("is rejected by validateTables when declared twice", () => {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			PRELUDE +
				`
export const post = createTable("post", {
	id: c.id("pst"),
	org_id: c.ref("org_id", { tenant: true }),
	workspace_id: c.ref("workspace_id", { tenant: true }),
})
`,
		)
		const result = validateTables(fp)
		expect(result.errors.join("\n")).toMatch(/2 columns declare \{ tenant: true \}/)
		expect(result.errors.join("\n")).toContain("org_id, workspace_id")
	})

	it("accepts a single declaration without complaint", () => {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			PRELUDE +
				`export const post = createTable("post", { id: c.id("pst"), org_id: c.ref("org_id", { tenant: true }) })`,
		)
		expect(validateTables(fp).errors).toEqual([])
	})

	it("reaches the generated read schema", () => {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(
			fp,
			PRELUDE +
				`export const post = createTable("post", { id: c.id("pst"), org_id: c.ref("org_id", { tenant: true }), title: c.text("title") })`,
		)
		const analysis = analyze(fp)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, fp, { output: outDir }, tmpDir)

		const generated = fs.readFileSync(path.join(outDir, "post", "index.gen.ts"), "utf-8")
		expect(generated).toContain(`tenantColumn: "org_id"`)
	})
})

describe("states is declared on c.enum, published without transitions", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-states-meta-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function analyzeSource(source: string) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + source)
		return { analysis: analyze(fp), tablesPath: fp }
	}

	const machine = `
export const delivery = createTable("delivery", {
	id: c.id("dlv"),
	status: c.enum("status", ["queued", "sending", "sent"], {
		initial: "queued",
		terminal: ["sent"],
		transitions: { queued: ["sending"], sending: ["sent"] },
	}),
})
`

	it("publishes column, values, initial and terminal — not transitions", () => {
		const { analysis } = analyzeSource(machine)
		expect(deriveEntityMeta(analysis.tables[0]!)?.states).toEqual({
			column: "status",
			initial: "queued",
			terminal: ["sent"],
			values: ["queued", "sending", "sent"],
		})
	})

	it("stays null when no machine is declared", () => {
		const { analysis } = analyzeSource(`
export const delivery = createTable("delivery", {
	id: c.id("dlv"),
	status: c.enum("status", ["queued", "sent"]),
})
`)
		expect(deriveEntityMeta(analysis.tables[0]!)?.states).toBeNull()
	})

	it("takes only the first declaring column", () => {
		const { analysis } = analyzeSource(`
export const delivery = createTable("delivery", {
	id: c.id("dlv"),
	status: c.enum("status", ["a", "b"], { terminal: ["b"] }),
	phase: c.enum("phase", ["x", "y"], { terminal: ["y"] }),
})
`)
		expect(deriveEntityMeta(analysis.tables[0]!)?.states?.column).toBe("status")
	})

	it("reaches the generated read schema without the graph", () => {
		const { analysis, tablesPath } = analyzeSource(machine)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, tablesPath, { output: outDir }, tmpDir)

		const generated = fs.readFileSync(path.join(outDir, "delivery", "index.gen.ts"), "utf-8")
		expect(generated).toContain(`column: "status"`)
		expect(generated).toContain(`initial: "queued"`)
		expect(generated).toContain(`terminal: ["sent"]`)
		expect(generated).toContain(`values: ["queued", "sending", "sent"]`)
		expect(generated).not.toMatch(/transitions/)
	})
})

describe("uniqueIndexes is copied from the analyzer, never inferred", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-unique-meta-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function analyzeSource(source: string) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + source)
		return { analysis: analyze(fp), tablesPath: fp }
	}

	const twoIndexes = `
export const post = createTable("post", {
	id: c.id("pst"),
	email: c.text("email"),
	org_id: c.ref("org_id"),
	slug: c.text("slug"),
}, (t) => [
	uniqueIndex("idx_post_email").on(t.email),
	uniqueIndex("idx_post_org_slug").on(t.org_id, t.slug),
])
`

	it("equals the analyzer's uniqueIndexes in both directions", () => {
		const { analysis } = analyzeSource(twoIndexes)
		const table = analysis.tables[0]!
		const meta = deriveEntityMeta(table)!

		expect(meta.uniqueIndexes).toEqual(table.uniqueIndexes)
		for (const idx of table.uniqueIndexes) {
			expect(meta.uniqueIndexes, `stamp omitted analyzer index ${idx.name}`).toContainEqual(idx)
		}
		for (const idx of meta.uniqueIndexes) {
			expect(table.uniqueIndexes, `stamp invented index ${idx.name}`).toContainEqual(idx)
		}
	})

	it("is [] when the table declares none — not inferred from a PK or column name", () => {
		const { analysis } = analyzeSource(`
export const post = createTable("post", {
	id: c.id("pst"),
	email: c.text("email"),
	slug: c.text("slug"),
})
`)
		const table = analysis.tables[0]!
		expect(table.uniqueIndexes).toEqual([])
		expect(deriveEntityMeta(table)?.uniqueIndexes).toEqual([])
	})

	it("reaches the generated read schema from deriveEntityMeta; create/update stay unstamped", () => {
		const { analysis, tablesPath } = analyzeSource(twoIndexes)
		const outDir = path.join(tmpDir, "dtos")
		generateDtos(analysis, tablesPath, { output: outDir }, tmpDir)

		const generated = fs.readFileSync(path.join(outDir, "post", "index.gen.ts"), "utf-8")
		const table = analysis.tables[0]!
		const meta = deriveEntityMeta(table)!
		const list = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`
		const rendered = `[${meta.uniqueIndexes.map((idx) => `{ columns: ${list(idx.columns)}, name: ${JSON.stringify(idx.name)} }`).join(", ")}]`

		expect(generated).toMatch(/postDtoReadSchema = z\.object\(\{[\s\S]*?\}\)\.meta\(combMeta\(\{/)
		expect(generated).toContain(`uniqueIndexes: ${rendered}`)
		expect(meta.uniqueIndexes).toEqual(table.uniqueIndexes)

		expect(generated.match(/combMeta\(\{/g)).toHaveLength(1)
		expect(generated).not.toMatch(/postDtoCreateSchema[\s\S]*?\.meta\(combMeta/)
		expect(generated).not.toMatch(/postDtoUpdateSchema[\s\S]*?\.meta\(combMeta/)
	})
})
