import { fixtureRoot } from "./__fixtures__/temp.ts"
import fs from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { analyze } from "./analyzer.ts"

/* the README, meta-contract §6.3/§8 and state-machines §2 declare tables with sqliteTable(...) */
const COLUMNS = `{
	id: text("id").primaryKey(),
	title: text("title").notNull(),
}`

describe("analyzer: table builders", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(fixtureRoot(), "comb-analyzer-builders-"))
	})

	afterEach(() => {
		fs.rmSync(dir, { force: true, recursive: true })
	})

	function tablesOf(source: string): string[] {
		const file = path.join(dir, "db.test.tables.ts")
		fs.writeFileSync(file, source)
		return analyze(file).tables.map((table) => `${table.varName}:${table.sqlName}`)
	}

	it.each([
		["sqliteTable", 'import { sqliteTable, text } from "drizzle-orm/sqlite-core"', "sqliteTable"],
		["pgTable", 'import { pgTable, text } from "drizzle-orm/pg-core"', "pgTable"],
		["an aliased sqliteTable", 'import { sqliteTable as table, text } from "drizzle-orm/sqlite-core"', "table"],
		["an aliased pgTable", 'import { pgTable as define, text } from "drizzle-orm/pg-core"', "define"],
		[
			"the createTable alias comb has always read",
			'import { sqliteTable as createTable, text } from "drizzle-orm/sqlite-core"',
			"createTable",
		],
	])("finds a table declared with %s", (_name, imports, builder) => {
		expect(tablesOf(`${imports}\nexport const post = ${builder}("posts", ${COLUMNS})\n`)).toEqual(["post:posts"])
	})

	it("ignores calls that are not a table builder", () => {
		const source = `import { text } from "drizzle-orm/sqlite-core"
const define = (name: string, cols: object) => ({ cols, name })
const make = (name: string, cols: object) => ({ name, cols })
export const a = make("a", ${COLUMNS})
export const b = define("b", ${COLUMNS})
`
		expect(tablesOf(source)).toEqual([])
	})
})
