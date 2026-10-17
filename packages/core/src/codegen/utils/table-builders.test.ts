import { describe, expect, it } from "vitest"
import { createProject } from "./ts-morph.ts"
import { isTableDefinition, tableBuilders } from "./table-builders.ts"

function buildersOf(source: string): string[] {
	const file = createProject().createSourceFile("db.x.tables.ts", source)
	return [...tableBuilders(file)].sort()
}

describe("tableBuilders", () => {
	it("is createTable alone when the file imports no table builder", () => {
		expect(buildersOf('import { text } from "drizzle-orm/sqlite-core"')).toEqual(["createTable"])
	})

	it("adds sqliteTable and pgTable under whatever local name the file gives them", () => {
		const source = [
			'import { sqliteTable, text } from "drizzle-orm/sqlite-core"',
			'import { pgTable as define } from "drizzle-orm/pg-core"',
			'import { sqliteTable as fromElsewhere } from "./not-drizzle"',
		].join("\n")
		expect(buildersOf(source)).toEqual(["createTable", "define", "sqliteTable"])
	})
})

describe("isTableDefinition", () => {
	const builders = new Set(["createTable", "sqliteTable"])

	it.each([
		['createTable("user", {})', true],
		['sqliteTable("post", {})', true],
		['  sqliteTable ("post", {})', true],
		['pgTable("post", {})', false],
		['sqliteTableX("post", {})', false],
		["someFunction()", false],
		["", false],
	])("%s → %s", (text, expected) => {
		expect(isTableDefinition(text, builders)).toBe(expected)
	})
})
