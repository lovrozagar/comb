import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { deriveEntityMeta } from "../../../../src/codegen/entity-meta.ts"
import { buildManifest, generateManifest, MANIFEST_VERSION } from "../../../../src/codegen/generators/manifest.ts"

const PRELUDE = `
import { sqliteTable as createTable, text, integer, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
const c = {
	id: (_p: string) => text("id").primaryKey(),
	text: (n: string, _o?: { max?: number; min?: number; pattern?: string; private?: boolean; nomutate?: boolean }) => text(n),
	integer: (n: string, _o?: { min?: number; max?: number }) => integer(n, { mode: "number" }),
	enum: (n: string, _v: readonly string[], _s?: object) => text(n),
	ref: (n: string, _o?: { tenant?: boolean }) => text(n),
	createdAt: (n: string) => integer(n, { mode: "number" }).notNull(),
	updatedAt: (n: string) => integer(n, { mode: "number" }).notNull(),
	deletedAt: (n: string) => integer(n, { mode: "number" }),
}
`

const SCHEMA = `
export const org = createTable("org", { id: c.id("org") })
export const author = createTable("author", { id: c.id("aut"), name: c.text("name") })
export const post = createTable("post", {
	id: c.id("pst"),
	org_id: c.ref("org_id", { tenant: true }).references(() => org.id, { onDelete: "cascade" }),
	author_id: c.ref("author_id").references(() => author.id, { onDelete: "set null" }),
	status: c.enum("status", ["draft", "published"]).notNull(),
	title: c.text("title", { max: 200, min: 2 }),
	secret: c.text("secret", { private: true }),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),
	deleted_at: c.deletedAt("deleted_at"),
}, (t) => [
	uniqueIndex("idx_post_title").on(t.title),
	check("post_status_enum", sql\`status IN ('draft','published')\`),
])
export const post_tag = createTable("post_tag", {
	post_id: c.ref("post_id"),
	tag_id: c.ref("tag_id"),
}, (t) => [primaryKey({ columns: [t.post_id, t.tag_id] })])
`

describe("entity manifest", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-manifest-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function analyzed(source = SCHEMA) {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + source)
		return analyze(fp)
	}

	const manifestOf = (source = SCHEMA) => {
		const analysis = analyzed(source)
		return buildManifest(analysis.tables, analysis.dbName)
	}

	const entity = (name: string, source = SCHEMA) => manifestOf(source).entities.find((e) => e.name === name)!

	it("carries a version and the database name", () => {
		const manifest = manifestOf()
		expect(manifest.v).toBe(MANIFEST_VERSION)
		expect(manifest.database).toBe("test")
	})

	it("sorts entities by name, so declaration order does not churn the file", () => {
		const names = manifestOf().entities.map((e) => e.name)
		expect(names).toEqual([...names].sort())
		expect(names).toEqual(["author", "org", "post", "post_tag"])
	})

	it("names the identity and the id prefix", () => {
		const post = entity("post")
		expect(post.identity).toBe("id")
		expect(post.idPrefix).toBe("pst")
		expect(post.varName).toBe("post")
	})

	it("reports a composite primary key as having no single identity", () => {
		const join = entity("post_tag")
		expect(join.compositePrimaryKey).toBe(true)
		expect(join.identity).toBeNull()
	})

	it("lists every column with the helper that declared it", () => {
		const post = entity("post")
		const byName = Object.fromEntries(post.columns.map((c) => [c.name, c]))

		expect(Object.keys(byName).sort()).toEqual([
			"author_id",
			"created_at",
			"deleted_at",
			"id",
			"org_id",
			"secret",
			"status",
			"title",
			"updated_at",
		])
		expect(byName["id"]!.primaryKey).toBe(true)
		expect(byName["status"]!.notNull).toBe(true)
		expect(byName["title"]!.primaryKey).toBe(false)
	})

	it("carries declared bounds and enum values", () => {
		const byName = Object.fromEntries(entity("post").columns.map((c) => [c.name, c]))
		expect(byName["title"]!.max).toBe(200)
		expect(byName["title"]!.min).toBe(2)
		expect(byName["status"]!.enumValues).toEqual(["draft", "published"])
		expect(byName["title"]!.enumValues).toBeNull()
	})

	it("marks private columns", () => {
		const byName = Object.fromEntries(entity("post").columns.map((c) => [c.name, c]))
		expect(byName["secret"]!.private).toBe(true)
		expect(byName["title"]!.private).toBe(false)
	})

	it("agrees with the schema stamp on generated, immutable, softDelete and tenantColumn", () => {
		/* The manifest is a projection of the same derivation, not a second one. */
		const analysis = analyzed()
		const table = analysis.tables.find((t) => t.sqlName === "post")!
		const meta = deriveEntityMeta(table)!
		const post = entity("post")

		expect(post.softDelete).toBe(meta.softDelete)
		expect(post.tenantColumn).toBe(meta.tenantColumn)

		const generated = post.columns.filter((c) => c.generated).map((c) => c.name)
		const immutable = post.columns.filter((c) => c.immutable).map((c) => c.name)
		expect(generated.sort()).toEqual([...meta.generated].sort())
		expect(immutable.sort()).toEqual([...meta.immutable].sort())
	})

	it("reports the declared tenant column", () => {
		expect(entity("post").tenantColumn).toBe("org_id")
		expect(entity("author").tenantColumn).toBeNull()
	})

	it("carries the full machine on the declaring column, including transitions", () => {
		const post = entity(
			"job",
			`
export const job = createTable("job", {
	id: c.id("job"),
	status: c.enum("status", ["queued", "done"], {
		initial: "queued",
		terminal: ["done"],
		transitions: { queued: ["done"] },
	}),
})
`,
		)
		const status = post.columns.find((c) => c.name === "status")!
		expect(status.states).toEqual({
			initial: "queued",
			terminal: ["done"],
			transitions: { queued: ["done"] },
		})
		expect(post.columns.find((c) => c.name === "id")!.states).toBeNull()
	})

	it("lists relations with their referential actions", () => {
		const relations = entity("post").relations
		expect(relations).toEqual([
			{ column: "org_id", onDelete: "cascade", onUpdate: null, refColumn: "id", table: "org" },
			{ column: "author_id", onDelete: "set null", onUpdate: null, refColumn: "id", table: "author" },
		])
	})

	it("carries unique indexes and check constraints", () => {
		const post = entity("post")
		expect(post.uniqueIndexes).toEqual([{ columns: ["title"], name: "idx_post_title" }])
		expect(post.checkConstraints.map((c) => c.name)).toEqual(["post_status_enum"])
	})

	it("is JSON round-trippable — no undefined, no Map, no Set", () => {
		const manifest = manifestOf()
		expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest)
	})

	describe("written output", () => {
		const outPath = () => path.join(tmpDir, "db.test.manifest.gen.json")

		function write(source = SCHEMA) {
			const analysis = analyzed(source)
			generateManifest(analysis.tables, analysis.dbName, { output: outPath() }, tmpDir)
			return JSON.parse(fs.readFileSync(outPath(), "utf-8")) as Record<string, unknown>
		}

		it("writes valid JSON with a checksum header field", () => {
			const written = write()
			expect(typeof written["_generated"]).toBe("string")
			expect(written["_generated"]).toContain("comb checksum:")
			expect(written["v"]).toBe(MANIFEST_VERSION)
		})

		it("is readable without parsing TypeScript", () => {
			const written = write() as unknown as { entities: { name: string }[] }
			expect(written.entities.map((e) => e.name)).toContain("post")
		})

		it("regenerates byte-identically for an unchanged schema", () => {
			write()
			const first = fs.readFileSync(outPath(), "utf-8")
			write()
			expect(fs.readFileSync(outPath(), "utf-8")).toBe(first)
		})

		it("changes when the schema changes", () => {
			write()
			const before = fs.readFileSync(outPath(), "utf-8")
			write(`${SCHEMA}\nexport const tag = createTable("tag", { id: c.id("tag") })`)
			expect(fs.readFileSync(outPath(), "utf-8")).not.toBe(before)
		})
	})
})
