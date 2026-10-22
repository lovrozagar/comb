import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateRelations } from "./relations.ts"
import { testContext } from "./__fixtures__/context.ts"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-relations-columns-"))
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

function relationsOf(tables: string): string {
	const file = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(file, `import { sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"\n${tables}`)
	const output = path.join(dir, "relations.gen.ts")
	generateRelations(testContext(analyze(file), { cwd: dir, tablesPath: file }), { output })
	return fs.readFileSync(output, "utf8")
}

describe("generateRelations: the columns a relation joins on", () => {
	it("joins the many side on the referenced column, not on id (M-M4)", () => {
		const content = relationsOf(`export const country = sqliteTable("country", { code: text("code").primaryKey() })
export const city = sqliteTable("city", {
	id: text("id").primaryKey(),
	country_code: text("country_code").references(() => country.code),
})`)
		expect(content).toContain(
			"citiesByCountryCode: r.many.city({\n\t\t\tfrom: r.country.code,\n\t\t\tto: r.city.country_code,",
		)
		expect(content).toContain(
			"countryCode: r.one.country({\n\t\t\tfrom: r.city.country_code,\n\t\t\tto: r.country.code,",
		)
	})

	it("relates a table to itself through an annotated self-reference (M-M3)", () => {
		const content = relationsOf(`export const folder = sqliteTable("folder", {
	id: text("id").primaryKey(),
	parent_id: text("parent_id").references((): AnySQLiteColumn => folder.id, { onDelete: "cascade" }),
})`)
		expect(content).toContain(
			"foldersByParent: r.many.folder({\n\t\t\tfrom: r.folder.id,\n\t\t\tto: r.folder.parent_id,",
		)
		expect(content).toContain("parent: r.one.folder({\n\t\t\tfrom: r.folder.parent_id,\n\t\t\tto: r.folder.id,")
	})
})

describe("generateRelations: one-relation names (D4)", () => {
	it("names a one-relation from the SQL column, whatever the key's case (D4)", () => {
		const content = relationsOf(`export const user = sqliteTable("user", { id: text("id").primaryKey() })
export const post = sqliteTable("post", {
	id: text("id").primaryKey(),
	authorId: text("author_id").references(() => user.id),
	editorId: text("editorId").references(() => user.id),
	invitedByUserId: text("invited_by_user_id").references(() => user.id),
	userId: text("userId").references(() => user.id),
})`)
		expect(content).toContain("author: r.one.user({\n\t\t\tfrom: r.post.authorId,")
		expect(content).toContain("editor: r.one.user({\n\t\t\tfrom: r.post.editorId,")
		expect(content).toContain("invitedBy: r.one.user({\n\t\t\tfrom: r.post.invitedByUserId,")
		expect(content).toContain("user: r.one.user({\n\t\t\tfrom: r.post.userId,")
	})

	it("keeps Id inside a word, and suffixes a name a column already holds (D4)", () => {
		const content = relationsOf(`export const user = sqliteTable("user", { id: text("id").primaryKey() })
export const post = sqliteTable("post", {
	id: text("id").primaryKey(),
	owner: text("owner"),
	ownerId: text("owner_id").references(() => user.id),
	paidId: text("paidId").references(() => user.id),
	rapid: text("rapid").references(() => user.id),
})`)
		expect(content).toContain("ownerRelation: r.one.user({\n\t\t\tfrom: r.post.ownerId,")
		expect(content).toContain("paid: r.one.user({\n\t\t\tfrom: r.post.paidId,")
		expect(content).toContain("rapidRelation: r.one.user({\n\t\t\tfrom: r.post.rapid,")
	})
})

describe("generateRelations: names a key added to either table never changes (F24)", () => {
	it("keeps an existing relation's name whichever key is added second, the plain one or another", () => {
		const user = 'export const user = sqliteTable("user", { id: text("id").primaryKey() })\n'
		const post = (...keys: string[]) =>
			relationsOf(
				`${user}export const post = sqliteTable("post", {\n\tid: text("id").primaryKey(),\n${keys.map((key) => `\t${key}: text("${key}").references(() => user.id),`).join("\n")}\n})`,
			)
		/* author first, then the plain user_id: postsByAuthor stays, posts is the newcomer's */
		expect(post("author_id")).toContain("postsByAuthor: r.many.post({")
		expect(post("author_id", "user_id")).toContain("postsByAuthor: r.many.post({")
		/* the plain user_id first, then author: posts stays */
		expect(post("user_id")).toContain("posts: r.many.post({")
		expect(post("user_id", "author_id")).toContain("posts: r.many.post({")
	})

	const USER = 'export const user = sqliteTable("user", { id: text("id").primaryKey() })\n'
	it("keeps post's relations as they were when a second key to user is added", () => {
		const one = relationsOf(`${USER}export const post = sqliteTable("post", {
	id: text("id").primaryKey(),
	user_id: text("user_id").references(() => user.id),
	author_id: text("author_id").references(() => user.id),
})`)
		const two = relationsOf(`${USER}export const post = sqliteTable("post", {
	id: text("id").primaryKey(),
	user_id: text("user_id").references(() => user.id),
	author_id: text("author_id").references(() => user.id),
	reviewer_id: text("reviewer_id").references(() => user.id),
})`)
		for (const content of [one, two]) {
			expect(content).toContain("posts: r.many.post({")
			expect(content).toContain("postsByAuthor: r.many.post({")
		}
		expect(two).toContain("postsByReviewer: r.many.post({")
	})
})

describe("generateRelations: names two relations would share (F7)", () => {
	const USER = 'export const user = sqliteTable("user", { id: text("id").primaryKey() })\n'
	it("fails, naming both keys, when two keys to one table take one role name, renaming neither", () => {
		expect(() =>
			relationsOf(`${USER}export const doc = sqliteTable("doc", {
	id: text("id").primaryKey(),
	owner_id: text("owner_id").references(() => user.id),
	owner_user_id: text("owner_user_id").references(() => user.id),
})`),
		).toThrow(
			/^doc: the relations of doc\.owner_id and doc\.owner_user_id both take the name owner; rename one key's column$/,
		)
	})

	it("fails, naming both keys, when the ways back from two tables pluralize alike", () => {
		expect(() =>
			relationsOf(`export const org = sqliteTable("org", { id: text("id").primaryKey() })
export const person = sqliteTable("person", { id: text("id").primaryKey(), org_id: text("org_id").references(() => org.id) })
export const people = sqliteTable("people", { id: text("id").primaryKey(), org_id: text("org_id").references(() => org.id) })`),
		).toThrow(/^org: the relations of (person|people)\.org_id and (person|people)\.org_id both take the name people/)
	})

	it("fails codegen, naming both keys, when two relations share every name", () => {
		expect(() =>
			relationsOf(`export const org = sqliteTable("org", { id: text("id").primaryKey() })
export const user_profile = sqliteTable("user_profile", { id: text("id").primaryKey(), org_id: text("org_id").references(() => org.id) })
export const userProfile = sqliteTable("userProfile", { id: text("id").primaryKey(), org_id: text("org_id").references(() => org.id) })`),
		).toThrow(
			/^org: the relations of (user_profile|userProfile)\.org_id and (user_profile|userProfile)\.org_id both take the name/,
		)
	})
})

describe("generateRelations: the way back of a unique key (F23)", () => {
	it("is one row, so r.one and singular", () => {
		const content = relationsOf(`export const user = sqliteTable("user", { id: text("id").primaryKey() })
export const profile = sqliteTable("profile", { id: text("id").primaryKey(), user_id: text("user_id").unique().references(() => user.id) })`)
		expect(content).toContain("profile: r.one.profile({\n\t\t\tfrom: r.user.id,\n\t\t\tto: r.profile.user_id,")
		expect(content).not.toContain("profiles:")
	})
})
