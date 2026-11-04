import { fixtureRoot } from "../__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { deriveEntityMeta } from "../entity-meta.ts"
import { buildManifest, generateManifest, MANIFEST_VERSION } from "./manifest.ts"
import { testContext } from "./__fixtures__/context.ts"

const PRELUDE = `
import { sqliteTable as createTable, text, integer, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import { c } from "@lovrozagar/comb/sqlite/columns"
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

/** A fresh temp directory per test, removed after it. */
function useTmpDir(prefix: string): () => string {
	let dir = ""
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(fixtureRoot(), prefix))
	})
	afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))
	return () => dir
}

/** A temp directory per test, and readers that analyze a schema written into it. */
function manifestFixture() {
	const tmpDir = useTmpDir("comb-manifest-")
	const analyzed = async (source = SCHEMA) => {
		const fp = path.join(tmpDir(), "db.test.tables.ts")
		fs.writeFileSync(fp, PRELUDE + source)
		return await analyze(fp)
	}
	const manifestOf = async (source = SCHEMA) => {
		const analysis = await analyzed(source)
		return buildManifest(analysis.tables, analysis.dbName, "sqlite")
	}
	const entity = async (name: string, source = SCHEMA) =>
		(await manifestOf(source)).entities.find((e) => e.name === name)!
	return { analyzed, entity, manifestOf, tmpDir }
}

describe("entity manifest — entities and identity", () => {
	const { analyzed, entity, manifestOf } = manifestFixture()

	it("carries a version and the database name", async () => {
		const manifest = await manifestOf()
		expect(manifest.v).toBe(MANIFEST_VERSION)
		expect(manifest.database).toBe("test")
	})

	it("sorts entities by name, so declaration order does not churn the file", async () => {
		const names = (await manifestOf()).entities.map((e) => e.name)
		expect(names).toEqual([...names].sort())
		expect(names).toEqual(["author", "org", "post", "post_tag"])
	})

	it("keeps declaration order between entities sharing a name", async () => {
		const [first] = (await analyzed()).tables
		const names = buildManifest([first!, { ...first!, varName: "twin" }], "test", "sqlite").entities.map(
			(e) => e.varName,
		)
		expect(names).toEqual([first!.varName, "twin"])
	})

	it("names the identity and the id prefix", async () => {
		const post = await entity("post")
		expect(post.identity).toBe("id")
		expect(post.idPrefix).toBe("pst")
		expect(post.varName).toBe("post")
	})

	it("reports a composite primary key as having no single identity", async () => {
		const join = await entity("post_tag")
		expect(join.compositePrimaryKey).toBe(true)
		expect(join.identity).toBeNull()
	})
})

describe("entity manifest — columns", () => {
	const { entity } = manifestFixture()

	it("lists every column with the helper that declared it", async () => {
		const post = await entity("post")
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

	it("carries declared bounds and enum values", async () => {
		const byName = Object.fromEntries((await entity("post")).columns.map((c) => [c.name, c]))
		expect(byName["title"]!.max).toBe(200)
		expect(byName["title"]!.min).toBe(2)
		expect(byName["status"]!.enumValues).toEqual(["draft", "published"])
		expect(byName["title"]!.enumValues).toBeNull()
	})

	it("marks private columns", async () => {
		const byName = Object.fromEntries((await entity("post")).columns.map((c) => [c.name, c]))
		expect(byName["secret"]!.private).toBe(true)
		expect(byName["title"]!.private).toBe(false)
	})

	it("reports the declared tenant column", async () => {
		expect((await entity("post")).tenantColumn).toBe("org_id")
		expect((await entity("author")).tenantColumn).toBeNull()
	})
})

/* C8 of r19: a reader that runs no TypeScript learns a column's format and rewrites, from the DTO's own list */
describe("entity manifest — a text column's kind and transforms", () => {
	const { entity } = manifestFixture()

	it("publishes each format and the rewrites the DTO publishes, in order", async () => {
		const body =
			'email: c.text("email", { email: true }), site: c.text("site", { url: true }), pic: c.text("pic", { imageUri: true }), pass: c.text("pass", { password: true }), who: c.text("who", { name: true, trim: true }), tag: c.text("tag", { lowercase: true, trim: true }), n: c.integer("n")'
		const columns = (await entity("item", `export const item = createTable("item", { id: c.id("itm"), ${body} })`))
			.columns
		const facts = columns
			.filter(({ name }) => name !== "id")
			.map(({ name, textKind, transform }) => [name, textKind, transform])
		expect(facts).toEqual([
			["email", "email", ["trim", "lowercase"]],
			["site", "url", ["trim", "strip-tab-newline"]],
			["pic", "imageUri", []],
			["pass", "password", []],
			["who", "name", ["trim"]],
			["tag", null, ["trim", "lowercase"]],
			["n", null, []],
		])
	})
})

describe("entity manifest — agreement with the schema stamp", () => {
	const { analyzed, entity } = manifestFixture()

	it("agrees with the schema stamp on generated, immutable, softDelete and tenantColumn", async () => {
		/* The manifest is a projection of the same derivation, not a second one. */
		const analysis = await analyzed()
		const table = analysis.tables.find((t) => t.sqlName === "post")!
		const meta = deriveEntityMeta(table)!
		const post = await entity("post")

		expect(post.softDelete).toBe(meta.softDelete)
		expect(post.tenantColumn).toBe(meta.tenantColumn)

		const generated = post.columns.filter((c) => c.generated).map((c) => c.name)
		const immutable = post.columns.filter((c) => c.immutable).map((c) => c.name)
		expect(generated.sort()).toEqual([...meta.generated].sort())
		expect(immutable.sort()).toEqual([...meta.immutable].sort())
	})

	it("agrees with the schema stamp on unique indexes both ways", async () => {
		const analysis = await analyzed()
		const table = analysis.tables.find((t) => t.sqlName === "post")!
		const meta = deriveEntityMeta(table)!
		const post = await entity("post")

		expect(post.uniqueIndexes).toEqual(meta.uniqueIndexes)
		for (const idx of meta.uniqueIndexes) {
			expect(post.uniqueIndexes, `manifest omitted stamp index ${idx.name}`).toContainEqual(idx)
		}
		for (const idx of post.uniqueIndexes) {
			expect(meta.uniqueIndexes, `manifest invented index ${idx.name}`).toContainEqual(idx)
		}
	})

	/* C7 of r17: the manifest is a projection of the stamp, partial unique indexes included */
	it("agrees with the schema stamp on partial unique indexes, a private one left out by both", async () => {
		const source = SCHEMA.replace(
			`uniqueIndex("idx_post_title").on(t.title),`,
			`uniqueIndex("idx_post_title").on(t.title),\n\tuniqueIndex("idx_post_title_live").on(t.title).where(sql\`\${t.deleted_at} IS NULL\`),\n\tuniqueIndex("idx_post_secret_live").on(t.secret).where(sql\`\${t.deleted_at} IS NULL\`),`,
		)
		const table = (await analyzed(source)).tables.find((t) => t.sqlName === "post")!
		const meta = deriveEntityMeta(table)!
		expect(meta.partialUniqueIndexes?.map((index) => index.name)).toEqual(["idx_post_title_live"])
		expect((await entity("post", source)).partialUniqueIndexes).toEqual(meta.partialUniqueIndexes)
	})

	it("leaves out a unique index over a private column, as the stamp does", async () => {
		const source = SCHEMA.replace(
			`uniqueIndex("idx_post_title").on(t.title),`,
			`uniqueIndex("idx_post_title").on(t.title),\n\tuniqueIndex("idx_post_secret").on(t.secret),`,
		)
		const table = (await analyzed(source)).tables.find((t) => t.sqlName === "post")!
		expect(table.uniqueIndexes.map((u) => u.name)).toContain("idx_post_secret")

		expect((await entity("post", source)).uniqueIndexes).toEqual(deriveEntityMeta(table)!.uniqueIndexes)
		expect((await entity("post", source)).uniqueIndexes.map((u) => u.name)).toEqual(["idx_post_title"])
	})
})

describe("entity manifest — machines and relations", () => {
	const { entity } = manifestFixture()

	it("carries the full machine on the declaring column, including transitions", async () => {
		const post = await entity(
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

	it("reports a machine without terminal states as an empty terminal list", async () => {
		const job = await entity(
			"job",
			`export const job = createTable("job", { id: c.id("job"), status: c.enum("status", ["a", "b"], { initial: "a" }) })`,
		)
		expect(job.columns.find((c) => c.name === "status")!.states).toEqual({
			initial: "a",
			terminal: [],
			transitions: null,
		})
	})

	it("reports a reference without referential actions as null actions", async () => {
		const source = `export const org = createTable("org", { id: c.id("org") })
export const team = createTable("team", { id: c.id("tem"), org_id: c.ref("org_id").references(() => org.id) })`
		expect((await entity("team", source)).relations).toEqual([
			{ column: "org_id", onDelete: null, onUpdate: null, refColumn: "id", table: "org" },
		])
	})

	it("lists relations with their referential actions", async () => {
		const relations = (await entity("post")).relations
		expect(relations).toEqual([
			{ column: "org_id", onDelete: "cascade", onUpdate: null, refColumn: "id", table: "org" },
			{ column: "author_id", onDelete: "set null", onUpdate: null, refColumn: "id", table: "author" },
		])
	})
})

describe("entity manifest — a composite foreign key", () => {
	const { entity } = manifestFixture()

	/* 4.20: a composite key is one key, each column paired by position, not independent pairs */
	it("states a composite foreign key as one key on each of its columns' relations", async () => {
		const source = `import { foreignKey } from "drizzle-orm/sqlite-core"
export const member = createTable("member", { org_id: c.text("org_id").notNull(), user_id: c.text("user_id").notNull() }, (t) => [primaryKey({ columns: [t.org_id, t.user_id] })])
export const grant = createTable("grant", { id: c.id("grt"), org_id: c.text("org_id").notNull(), user_id: c.text("user_id").notNull() }, (t) => [foreignKey({ columns: [t.org_id, t.user_id], foreignColumns: [member.org_id, member.user_id] })])`
		const key = { columns: ["org_id", "user_id"], refColumns: ["org_id", "user_id"] }
		expect((await entity("grant", source)).relations).toEqual([
			{ column: "org_id", key, onDelete: null, onUpdate: null, refColumn: "org_id", table: "member" },
			{ column: "user_id", key, onDelete: null, onUpdate: null, refColumn: "user_id", table: "member" },
		])
	})
})

describe("entity manifest — constraints and JSON", () => {
	const { entity, manifestOf } = manifestFixture()

	it("carries unique indexes and check constraints", async () => {
		const post = await entity("post")
		expect(post.uniqueIndexes).toEqual([{ columns: ["title"], name: "idx_post_title" }])
		expect(post.checkConstraints.map((c) => c.name)).toEqual(["post_status_enum"])
	})

	it("is JSON round-trippable — no undefined, no Map, no Set", async () => {
		const manifest = await manifestOf()
		expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest)
	})
})

describe("entity manifest — written output", () => {
	const { analyzed, tmpDir } = manifestFixture()
	const outPath = () => path.join(tmpDir(), "db.test.manifest.gen.json")

	async function write(source = SCHEMA) {
		const analysis = await analyzed(source)
		generateManifest(testContext(analysis, { cwd: tmpDir() }), { output: outPath() })
		return JSON.parse(fs.readFileSync(outPath(), "utf-8")) as Record<string, unknown>
	}

	it("writes valid JSON with a checksum header field", async () => {
		const written = await write()
		expect(typeof written["_generated"]).toBe("string")
		expect(written["_generated"]).toContain("comb checksum:")
		expect(written["v"]).toBe(MANIFEST_VERSION)
	})

	it("is readable without parsing TypeScript", async () => {
		const written = (await write()) as unknown as { entities: { name: string }[] }
		expect(written.entities.map((e) => e.name)).toContain("post")
	})

	it("regenerates byte-identically for an unchanged schema", async () => {
		await write()
		const first = fs.readFileSync(outPath(), "utf-8")
		await write()
		expect(fs.readFileSync(outPath(), "utf-8")).toBe(first)
	})

	it("changes when the schema changes", async () => {
		await write()
		const before = fs.readFileSync(outPath(), "utf-8")
		await write(`${SCHEMA}\nexport const tag = createTable("tag", { id: c.id("tag") })`)
		expect(fs.readFileSync(outPath(), "utf-8")).not.toBe(before)
	})
})
