import { describe, expect, it } from "vitest"
import { columnKey, columnNames, tableDefinition } from "./schema-table.ts"

describe("tableDefinition", () => {
	it("reads keys, affinity, resolutions, STRICT and the rowid alias of one CREATE TABLE", () => {
		const { info, keys } = tableDefinition(
			"CREATE TABLE t (id INTEGER PRIMARY KEY, u integer REFERENCES Users(id) ON DELETE CASCADE, code TEXT UNIQUE ON CONFLICT IGNORE, n, CONSTRAINT fk FOREIGN KEY (n) REFERENCES u (id)) STRICT",
			"t",
			"sqlite",
		)
		expect(info).toEqual({
			affinity: { code: "TEXT", id: "INTEGER", n: "BLOB", u: "INTEGER" },
			autoincrement: false,
			conflicts: ["code: IGNORE"],
			generatedColumns: [],
			primaryKey: ["id"],
			rowidAlias: true,
			strict: true,
			withoutRowid: false,
		})
		expect(keys).toEqual([
			{ columns: ["u"], onDelete: "CASCADE", parent: "users", parentColumns: ["id"], table: "t" },
			{ columns: ["n"], onDelete: "NO ACTION", parent: "u", parentColumns: ["id"], table: "t" },
		])
	})

	it("keeps a table-level key's columns, and no rowid alias for a composite or DESC key", () => {
		expect(
			tableDefinition("CREATE TABLE t (a text, b int, PRIMARY KEY (a, b DESC))", "t", "sqlite").info.primaryKey,
		).toEqual(["a", "b"])
		expect(tableDefinition("CREATE TABLE t (id INTEGER PRIMARY KEY DESC)", "t", "sqlite").info.rowidAlias).toBe(false)
	})
})

describe("columnNames and columnKey", () => {
	it("lists the columns a CREATE TABLE declares, constraints left out", () => {
		expect(columnNames('CREATE TABLE t ("Id" int, b text, UNIQUE (b))')).toEqual(["Id", "b"])
	})

	it("reads an inline key's parent as its dialect resolves the name", () => {
		expect(
			columnKey('integer REFERENCES "Users"(id)', { column: "u", naming: { schema: "public" }, table: "t" })?.parent,
		).toBe("Users")
		expect(
			columnKey("integer REFERENCES Users(id)", { column: "u", naming: { schema: "public" }, table: "t" })?.parent,
		).toBe("users")
		expect(columnKey("integer", { column: "u", naming: "sqlite", table: "t" })).toBeUndefined()
	})
})
