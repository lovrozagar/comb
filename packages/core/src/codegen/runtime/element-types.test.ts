/**
 * A2-9 of r22: an array column's element takes null as its drizzle type declares it, read by
 * TypeScript's checker from the tables file itself; a column the checker cannot answer for fails
 * codegen naming it, as either default would build a DTO the app's own types disagree with.
 */
import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { elementNullsOf } from "./element-types.ts"

/* inside the package, so the tables file's drizzle import resolves as an app's does */
const DIR = fs.mkdtempSync(path.join(import.meta.dirname, "../../../.tmp-codegen-elements-"))
afterAll(() => fs.rmSync(DIR, { force: true, recursive: true }))

/** A tables file of `body`, named `file`, beside the files `beside`, its path */
function tables(
	name: string,
	body: string,
	{ beside = {}, file: named = "db.core.tables.ts" }: { beside?: Record<string, string>; file?: string } = {},
): string {
	const dir = path.join(DIR, name)
	fs.mkdirSync(dir, { recursive: true })
	for (const [each, text] of Object.entries(beside)) fs.writeFileSync(path.join(dir, each), text)
	const file = path.join(dir, named)
	fs.writeFileSync(file, `import { integer, pgTable, text } from "drizzle-orm/pg-core"\n${body}\n`)
	return file
}

const ROW = `type Open = string | null
export const row = pgTable("row", {
	id: text("id").primaryKey(),
	tags: text("tags").array().notNull(),
	maybe: text("maybe").array(),
	open: text("open").array().$type<string | null>(),
	before: text("before").$type<string | null>().array(),
	aliased: text("aliased").array().$type<Open>(),
	anything: text("anything").array().$type<any>(),
	grid: integer("grid").array("[][]"),
	openGrid: integer("open_grid").array("[][]").$type<number | null>(),
})
export { row as again }`

describe("elementNullsOf: what an array column's element takes, by its drizzle type", () => {
	const nulls = elementNullsOf(tables("row", ROW))

	it.each([
		["tags", 1, false],
		["maybe", 1, false],
		["open", 1, true],
		["before", 1, true],
		["aliased", 1, true],
		["anything", 1, true],
		["grid", 2, false],
		["openGrid", 2, true],
	] as const)("reads %s, of %i dimensions, as taking null: %s", (key, dimensions, expected) => {
		expect(nulls("row", key, dimensions)).toBe(expected)
	})

	it("reads a table under any name the tables file exports it by", () => {
		expect(nulls("again", "open", 1)).toBe(true)
	})

	it("refuses a table the tables file does not export, naming the column", () => {
		expect(() => nulls("gone", "tags", 1)).toThrow(
			/^gone\.tags: codegen reads an array column's element type from its table's \$inferInsert, which TypeScript cannot resolve for the export gone of /,
		)
	})

	it("refuses a key its table's $inferInsert does not hold, naming the column", () => {
		expect(() => nulls("row", "absent", 1)).toThrow(/^row\.absent: codegen reads an array column's element type/)
	})

	it("refuses a type of fewer dimensions than the column declares, naming it and its type", () => {
		expect(() => nulls("row", "tags", 2)).toThrow(
			"row.tags: its $inferInsert type, string[], is no array of 2 dimensions, which the column declares; type its element with $type<E>()",
		)
	})
})

/* the project's typecheck reports a type error; the read fails only on one it cannot read past */
describe("elementNullsOf on a tables file that holds a type error", () => {
	it("reads a tables file's array column whatever type error the file holds elsewhere", () => {
		const file = tables(
			"unrelated",
			`const wrong: number = "a"
export const row = pgTable("row", { id: text("id").primaryKey().notAColumnMethod(), tags: text("tags").array().$type<string | null>() })`,
		)
		expect(elementNullsOf(file)("row", "tags", 1)).toBe(true)
	})

	it("refuses an element type the tables file names but never declares, naming the column", () => {
		const file = tables(
			"undeclared",
			`export const row = pgTable("row", { tags: text("tags").array().$type<Missing>() })`,
		)
		expect(() => elementNullsOf(file)("row", "tags", 1)).toThrow(
			"row.tags: its element type, Missing, does not resolve, so codegen cannot read whether it takes null; fix the type its $type<E>() names",
		)
	})

	it("refuses an element type another module leaves unresolved, naming the column", () => {
		const file = tables(
			"unresolved",
			`import type { Tag } from "./types.ts"
export const row = pgTable("row", { tags: text("tags").array().$type<Tag>() })`,
			{ beside: { "types.ts": "export type Tag = Missing\n" } },
		)
		expect(() => elementNullsOf(file)("row", "tags", 1)).toThrow(
			"row.tags: its element type, Missing, does not resolve, so codegen cannot read whether it takes null; fix the type its $type<E>() names",
		)
	})
})

/* A3-1 of r23: a tables module in JavaScript, which declares no $type, its element as its builder types it */
describe("elementNullsOf on a JavaScript tables module", () => {
	const JS = `export const row = pgTable("row", { tags: text("tags").array(), grid: integer("grid").array("[][]") })`

	it.each(["db.core.tables.js", "db.core.tables.mjs"])("reads %s, its elements taking no null", (file) => {
		const nulls = elementNullsOf(tables(file.replace(/\W/g, "-"), JS, { file }))
		expect([nulls("row", "tags", 1), nulls("row", "grid", 2)]).toEqual([false, false])
	})

	it("reads one under a tsconfig that sets allowJs false", () => {
		const beside = { "tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: false } }) }
		expect(elementNullsOf(tables("no-js", JS, { beside, file: "db.core.tables.js" }))("row", "tags", 1)).toBe(false)
	})

	it("refuses a column of a script, which no module symbol stands for, naming it", () => {
		const file = tables("script", "")
		fs.writeFileSync(file, "const row = 1\n")
		expect(() => elementNullsOf(file)("row", "tags", 1)).toThrow(
			/^row\.tags: codegen reads an array column's element type from its table's \$inferInsert, which TypeScript cannot resolve for the export row of /,
		)
	})
})
