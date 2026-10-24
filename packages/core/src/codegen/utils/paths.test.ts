import { describe, expect, it } from "vitest"
import { extractDbName, getTablesImportPath, importPathFrom } from "./paths.ts"

describe("extractDbName", () => {
	it("extracts from db.core.tables.ts pattern", () => {
		expect(extractDbName("/some/path/db.core.tables.ts")).toBe("core")
	})

	it("extracts from saas pattern: csvme.db.shard.tables.gen.ts", () => {
		expect(extractDbName("/path/csvme.db.shard.tables.gen.ts")).toBe("shard")
	})

	it("returns 'db' for plain tables.ts", () => {
		expect(extractDbName("/path/tables.ts")).toBe("db")
		/* the README's layout: src/db/core.tables.ts */
		expect(extractDbName("/path/src/db/core.tables.ts")).toBe("core")
	})

	it("extracts from nested path", () => {
		expect(extractDbName("/a/b/c/db.auth.tables.ts")).toBe("auth")
	})
})

describe("getTablesImportPath", () => {
	it("returns relative path without .ts extension", () => {
		expect(getTablesImportPath("/path/db.core.tables.ts")).toBe("./db.core.tables")
	})

	it("handles nested filename", () => {
		expect(getTablesImportPath("/a/b/my.db.shard.tables.gen.ts")).toBe("./my.db.shard.tables.gen")
	})
})
describe("extractDbName — naming conventions", () => {
	const cases: Array<[string, string]> = [
		["/x/app.db-core.tables.ts", "core"],
		["/x/app.db.growth.tables.gen.ts", "growth"],
		["/x/db.core.tables.ts", "core"],
		["/x/whatever.ts", "db"],
		["/x/tables.ts", "db"],
	]

	for (const [input, expected] of cases) {
		it(`reads ${expected} from ${input.split("/").pop()}`, () => {
			expect(extractDbName(input)).toBe(expected)
		})
	}

	it("prefers the prefixed pattern over the others", () => {
		expect(extractDbName("/x/db.wrong.db-right.tables.ts")).toBe("right")
	})
})

describe("getTablesImportPath", () => {
	it("drops the extension and makes the path relative to the same directory", () => {
		expect(getTablesImportPath("/a/b/db.core.tables.ts")).toBe("./db.core.tables")
		expect(getTablesImportPath("db.core.tables.gen.ts")).toBe("./db.core.tables.gen")
	})
})

describe("importPathFrom", () => {
	it("imports a sibling with ./, a file elsewhere with ../, never with .ts", () => {
		expect(importPathFrom("/p/src/gen/orm.gen.ts", "/p/src/gen/db.relations.gen.ts")).toBe("./db.relations.gen")
		expect(importPathFrom("/p/src/gen/orm.gen.ts", "/p/src/db/db.core.tables.ts")).toBe("../db/db.core.tables")
	})
})
