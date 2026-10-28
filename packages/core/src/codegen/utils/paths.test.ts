import { describe, expect, it } from "vitest"
import { extractDbName, getTablesImportPath, importPathFrom, importStyleOf, specifierFor, styled } from "./paths.ts"

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

/* F53: a relative import in the form the consumer's TypeScript resolves */
describe("the consumer's import style", () => {
	it("is an extension under node16 and nodenext, .ts where the consumer imports .ts, and none otherwise", () => {
		expect(importStyleOf({})).toBe("bare")
		/* ts.ModuleResolutionKind: Bundler 100, Node10 2 */
		expect(importStyleOf({ moduleResolution: 100 })).toBe("bare")
		expect(importStyleOf({ moduleResolution: 2 })).toBe("bare")
		expect(importStyleOf({ moduleResolution: 3 })).toBe("js")
		expect(importStyleOf({ moduleResolution: 99 })).toBe("js")
		expect(importStyleOf({ allowImportingTsExtensions: true, moduleResolution: 99 })).toBe("ts")
		expect(importStyleOf({ moduleResolution: 99, rewriteRelativeImportExtensions: true })).toBe("ts")
	})

	it("names a TypeScript file by its extension in the style, and a JavaScript or declaration file as it is", () => {
		expect(styled("../_shared/index.gen", "bare")).toBe("../_shared/index.gen")
		expect(styled("../_shared/index.gen", "js")).toBe("../_shared/index.gen.js")
		expect(styled("../_shared/index.gen", "ts")).toBe("../_shared/index.gen.ts")
		expect(specifierFor("/p/a", "/p/db/core.tables.mts", "js")).toBe("../db/core.tables.mjs")
		expect(specifierFor("/p/a", "/p/db/core.tables.cts", "ts")).toBe("../db/core.tables.cts")
		expect(specifierFor("/p/a", "/p/db/core.tables.mts", "bare")).toBe("../db/core.tables.mts")
		expect(specifierFor("/p", "/p/schemas.js", "js")).toBe("./schemas.js")
		expect(specifierFor("/p", "/p/schemas.d.ts", "js")).toBe("./schemas.d.ts")
		expect(importPathFrom("/p/src/gen/orm.gen.ts", "/p/src/db/db.core.tables.ts", "js")).toBe("../db/db.core.tables.js")
	})
})
