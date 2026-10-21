import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateRelations } from "./relations.ts"
import { testContext } from "./__fixtures__/context.ts"

const HEAD = `import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = { id: () => text("id").primaryKey(), ref: (name: string) => text(name) }
export const user = createTable("user", { id: c.id() })
`

let tmpDir: string

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-relations-"))
})

afterEach(() => {
	fs.rmSync(tmpDir, { force: true, recursive: true })
})

/** Generate relations for tables declared after a `user` table; returns the file and the logged lines */
function generate(tables: string, file = "db.test.tables.ts"): { content: string; logged: string[] } {
	const tablesPath = path.join(tmpDir, file)
	fs.writeFileSync(tablesPath, `${HEAD}${tables}\n`)
	const ctx = testContext(analyze(tablesPath), { cwd: tmpDir, tablesPath })
	const output = path.join(tmpDir, "relations.gen.ts")
	generateRelations(ctx, { output })
	return { content: fs.readFileSync(output, "utf-8"), logged: ctx.logged }
}

describe("generateRelations", () => {
	it("writes r.one on the FK's table and r.many on the referenced one, sorted by name", () => {
		const { content } = generate(`export const post = createTable("post", {
	id: c.id(),
	user_id: c.ref("user_id").references(() => user.id).notNull(),
})`)
		expect(content.slice(content.indexOf("\n") + 1)).toBe(`import { defineRelations } from "drizzle-orm"
import * as schema from "./db.test.tables"

export const relations = defineRelations(schema, (r) => ({
	post: {
		user: r.one.user({
			from: r.post.user_id,
			to: r.user.id,
		}),
	},
	user: {
		posts: r.many.post({
			from: r.user.id,
			to: r.post.user_id,
		}),
	},
}))
`)
	})

	it("imports the tables file by its own name and logs what it counted", () => {
		const { content, logged } = generate(
			`export const post = createTable("post", { id: c.id(), user_id: c.ref("user_id").references(() => user.id) })
export const tag = createTable("tag", { id: c.id() })`,
			"db.test.tables.gen.ts",
		)
		expect(content).toContain(`import * as schema from "./db.test.tables.gen"`)
		expect(content).not.toContain("tag: {")
		expect(logged[0]).toMatch(/^Generated relations: .*relations\.gen\.ts$/)
		expect(logged[1]).toBe("Tables: 3, r.one: 1, r.many: 1")
	})
})

describe("generateRelations — relation names", () => {
	it("names r.one by the prefix before the referenced table", () => {
		const { content } = generate(`export const invite = createTable("invite", {
	id: c.id(),
	invited_by_user_id: c.ref("invited_by_user_id").references(() => user.id),
})`)
		expect(content).toContain("invitedBy: r.one.user")
	})

	it("falls back to the column without _id when it does not name the table", () => {
		const { content } = generate(`export const doc = createTable("doc", {
	id: c.id(),
	owner_id: c.ref("owner_id").references(() => user.id),
	_user_id: c.ref("_user_id").references(() => user.id),
})`)
		expect(content).toContain("owner: r.one.user")
		expect(content).toContain("User: r.one.user")
	})

	it("disambiguates several r.many from one table by their columns", () => {
		const { content } = generate(`export const transfer = createTable("transfer", {
	id: c.id(),
	sender_user_id: c.ref("sender_user_id").references(() => user.id),
	receiver_user_id: c.ref("receiver_user_id").references(() => user.id),
})`)
		expect(content).toContain("transfersByReceiverUser: r.many.transfer")
		expect(content).toContain("transfersBySenderUser: r.many.transfer")
	})
})

describe("generateRelations without a relation (F10)", () => {
	it("takes no r it would not use, which noUnusedParameters refuses", () => {
		const { content } = generate("")
		expect(content).toContain("export const relations = defineRelations(schema, () => ({}))")
		expect(content).not.toContain("(r)")
	})
})

describe("generateRelations — a key to a table outside the file", () => {
	it("writes the one side, and no many side for a table the file does not declare", () => {
		const { content } = generate(`import { account } from "./elsewhere"
export const post = createTable("post", { id: c.id(), accountId: c.ref("account_id").references(() => account.id) })`)
		/* the many side has no table of the file to live on; the one side does */
		expect(content).toContain("account: r.one.account(")
		expect(content).not.toContain("r.many.post(")
	})
})
