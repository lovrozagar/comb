import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "../analyzer.ts"
import { generateRelations } from "./relations.ts"
import { testContext } from "./__fixtures__/context.ts"

describe("generateRelations: the columns a relation joins on", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "comb-gen-relations-columns-"))
	})

	afterEach(() => fs.rmSync(dir, { force: true, recursive: true }))

	function relationsOf(tables: string): string {
		const file = path.join(dir, "db.test.tables.ts")
		fs.writeFileSync(
			file,
			`import { sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core"\n${tables}`,
		)
		const output = path.join(dir, "relations.gen.ts")
		generateRelations(testContext(analyze(file), { cwd: dir, tablesPath: file }), { output })
		return fs.readFileSync(output, "utf8")
	}

	it("joins the many side on the referenced column, not on id (M-M4)", () => {
		const content = relationsOf(`export const country = sqliteTable("country", { code: text("code").primaryKey() })
export const city = sqliteTable("city", {
	id: text("id").primaryKey(),
	country_code: text("country_code").references(() => country.code),
})`)
		expect(content).toContain("cities: r.many.city({\n\t\t\tfrom: r.country.code,\n\t\t\tto: r.city.country_code,")
		expect(content).toContain(
			"countryCode: r.one.country({\n\t\t\tfrom: r.city.country_code,\n\t\t\tto: r.country.code,",
		)
	})

	it("relates a table to itself through an annotated self-reference (M-M3)", () => {
		const content = relationsOf(`export const folder = sqliteTable("folder", {
	id: text("id").primaryKey(),
	parent_id: text("parent_id").references((): AnySQLiteColumn => folder.id, { onDelete: "cascade" }),
})`)
		expect(content).toContain("folders: r.many.folder({\n\t\t\tfrom: r.folder.id,\n\t\t\tto: r.folder.parent_id,")
		expect(content).toContain("parent: r.one.folder({\n\t\t\tfrom: r.folder.parent_id,\n\t\t\tto: r.folder.id,")
	})
})
