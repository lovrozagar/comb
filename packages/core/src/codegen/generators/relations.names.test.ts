/**
 * F57 of the 0.13.0 round: a key may name its own relation. A key column whose role is its own
 * name, a natural key (currency → currency.code) or a self-reference named parent, collides with
 * itself; renaming the database column to suit a TypeScript property is a migration in every
 * environment, so the key's `relation` names it instead. No relation is ever renamed silently.
 */
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { fixtureRoot } from "../__fixtures__/temp.ts"
import { generateRelations } from "./relations.ts"
import { testContext } from "./__fixtures__/context.ts"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-gen-relations-names-"))
})

afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

const HEAD = `import { sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const currency = sqliteTable("currency", { code: text("code").primaryKey() })
`

function relationsOf(tables: string): string {
	const file = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(file, `${HEAD}${tables}`)
	const output = path.join(dir, "relations.gen.ts")
	generateRelations(testContext(analyze(file), { cwd: dir, tablesPath: file }), { output })
	return fs.readFileSync(output, "utf8")
}

describe("generateRelations: a key that names its relation (F57)", () => {
	it("names the fix in the collision: rename the column, or give the key its relation", () => {
		expect(() =>
			relationsOf(
				'export const price = sqliteTable("price", { id: text("id").primaryKey(), currency: c.ref("currency").references(() => currency.code) })',
			),
		).toThrow(
			'price: the relation currency of price.currency takes the name of the column price.currency; rename the column, or give the key { relation: "…" }',
		)
	})

	it("names the relation, and its way back, by the key's relation", () => {
		const content = relationsOf(`export const price = sqliteTable("price", {
	id: text("id").primaryKey(),
	currency: c.ref("currency", { relation: "currencyOf" }).references(() => currency.code),
	parent: c.ref("parent", { relation: "parentPrice" }).references((): AnySQLiteColumn => price.id),
})`)
		expect(content).toContain("currencyOf: r.one.currency({\n\t\t\tfrom: r.price.currency,")
		expect(content).toContain("pricesByCurrencyOf: r.many.price(")
		expect(content).toContain("parentPrice: r.one.price({\n\t\t\tfrom: r.price.parent,")
	})

	it("refuses a relation on a column that references nothing, and one a column already holds", () => {
		expect(() =>
			relationsOf(
				'export const price = sqliteTable("price", { id: text("id").primaryKey(), note: c.text("note", { relation: "noteOf" }) })',
			),
		).toThrow("db.test.tables.ts: price.note: relation names the relation of a key, and note references nothing")
		expect(() =>
			relationsOf(
				'export const price = sqliteTable("price", { id: text("id").primaryKey(), currency: c.ref("currency", { relation: "id" }).references(() => currency.code) })',
			),
		).toThrow("price: the relation id of price.currency takes the name of the column price.id")
	})
})

/** A blog_post table exported as `target`, and the comments that reference it, plain and by a role */
const blogKeys = (target: string) => `export const ${target} = sqliteTable("blog_post", { id: text("id").primaryKey() })
export const blog_comment = sqliteTable("blog_comment", {
	id: text("id").primaryKey(),
	blog_post_id: text("blog_post_id").references(() => ${target}.id),
	invited_by_blog_post_id: text("invited_by_blog_post_id").references(() => ${target}.id),
})`

/* F62: a key's role is compared with its target's export name camelCased, so a snake_case export names its relations as a camelCase one does */
describe("generateRelations: a snake_case export's relations (F62)", () => {
	it("names them as a camelCase export's, where 0.13 named them blogCommentsByBlogPost and invitedByBlogPost", () => {
		const snake = relationsOf(blogKeys("blog_post"))
		const camel = relationsOf(blogKeys("blogPost"))
		for (const content of [snake, camel]) {
			expect(content).toContain("blogPost: r.one.")
			expect(content).toContain("invitedBy: r.one.")
			expect(content).toContain("blogComments: r.many.blog_comment(")
			expect(content).toContain("blogCommentsByInvitedBy: r.many.blog_comment(")
		}
		expect(snake).not.toContain("blogCommentsByBlogPost")
		expect(snake).not.toContain("invitedByBlogPost")
	})
})
