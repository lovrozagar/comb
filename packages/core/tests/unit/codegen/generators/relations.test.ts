import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../../../../src/codegen/analyzer.ts"
import { generateRelations } from "../../../../src/codegen/generators/relations.ts"

describe("generateRelations", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-relations-"))
	})

	afterEach(() => {
		fs.rmSync(tmpDir, { force: true, recursive: true })
	})

	function writeTablesAndAnalyze(content: string): ReturnType<typeof analyze> {
		const fp = path.join(tmpDir, "db.test.tables.ts")
		fs.writeFileSync(fp, content)
		return analyze(fp)
	}

	it("generates r.one and r.many relations from FKs", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id() })
export const post = createTable("post", {
	id: c.id(),
	user_id: c.ref("user_id").references(() => user.id).notNull(),
})
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const outputPath = path.join(tmpDir, "relations.gen.ts")
		generateRelations(result.tables, tablesPath, { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		expect(content).toContain("defineRelations")
		/* post has r.one to user */
		expect(content).toContain("user: r.one.user")
		expect(content).toContain("from: r.post.user_id")
		/* user has r.many from post */
		expect(content).toContain("posts: r.many.post")
	})

	it("derives relation names from FK columns", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id() })
export const invite = createTable("invite", {
	id: c.id(),
	invited_by_user_id: c.ref("invited_by_user_id").references(() => user.id),
})
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const outputPath = path.join(tmpDir, "relations.gen.ts")
		generateRelations(result.tables, tablesPath, { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		/* invited_by_user_id with refTable=user -> invitedBy */
		expect(content).toContain("invitedBy: r.one.user")
	})

	it("disambiguates multiple FKs to same target", () => {
		const result = writeTablesAndAnalyze(`
import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"
const c = {
	id: () => text("id").primaryKey(),
	ref: (name: string) => text(name),
}
export const user = createTable("user", { id: c.id() })
export const transfer = createTable("transfer", {
	id: c.id(),
	sender_user_id: c.ref("sender_user_id").references(() => user.id),
	receiver_user_id: c.ref("receiver_user_id").references(() => user.id),
})
`)
		const tablesPath = path.join(tmpDir, "db.test.tables.ts")
		const outputPath = path.join(tmpDir, "relations.gen.ts")
		generateRelations(result.tables, tablesPath, { output: outputPath }, tmpDir)

		const content = fs.readFileSync(outputPath, "utf-8")
		/* Multiple FKs from transfer -> user should disambiguate */
		expect(content).toContain("transfersBy")
	})
})
