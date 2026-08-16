import { describe, expect, it } from "vitest"
import {
	buildIdentifierValueMap,
	extractConstraints,
	extractDbName,
	extractEnumFromType,
	extractEnumValues,
	extractJsonSchemaImports,
	extractLength,
	extractStates,
	getTablesImportPath,
	isTableDefinition,
	setIdentifierValueMap,
} from "../../../../src/codegen/utils/ts-morph.ts"

describe("extractDbName", () => {
	it("extracts from db.core.tables.ts pattern", () => {
		expect(extractDbName("/some/path/db.core.tables.ts")).toBe("core")
	})

	it("extracts from saas pattern: csvme.db.shard.tables.gen.ts", () => {
		expect(extractDbName("/path/csvme.db.shard.tables.gen.ts")).toBe("shard")
	})

	it("returns 'db' for plain tables.ts", () => {
		expect(extractDbName("/path/tables.ts")).toBe("db")
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

describe("extractEnumFromType", () => {
	it("extracts from .$type<(typeof ENUM)[number]> pattern", () => {
		expect(extractEnumFromType('text("role").$type<(typeof ROLES)[number]>()')).toBe("ROLES")
	})

	it("extracts from c.enum() pattern", () => {
		expect(extractEnumFromType('c.enum("status", STATUS_ENUM)')).toBe("STATUS_ENUM")
	})

	it("still sees the const name when a state machine follows", () => {
		expect(extractEnumFromType('c.enum("status", STATUS_ENUM, { terminal: ["done"] })')).toBe("STATUS_ENUM")
	})

	it("returns null for no enum", () => {
		expect(extractEnumFromType('c.text("name")')).toBeNull()
	})
})

describe("extractEnumValues", () => {
	it("reads an inline list", () => {
		expect(extractEnumValues('c.enum("status", ["draft", "sent"])')).toEqual(["draft", "sent"])
	})

	it("still reads the list when a state machine is the third argument", () => {
		expect(extractEnumValues('c.enum("status", ["draft", "sent"], { terminal: ["sent"] })')).toEqual(["draft", "sent"])
	})

	it("returns null for a const reference", () => {
		expect(extractEnumValues('c.enum("status", STATUS_ENUM)')).toBeNull()
		expect(extractEnumValues('c.enum("status", STATUS_ENUM, { terminal: ["done"] })')).toBeNull()
	})

	it("returns null for a non-enum column", () => {
		expect(extractEnumValues('c.text("name")')).toBeNull()
	})
})

describe("extractStates", () => {
	it("reads a full machine off the third argument", () => {
		expect(
			extractStates(
				'c.enum("status", ["queued", "sending", "sent"], { initial: "queued", terminal: ["sent"], transitions: { queued: ["sending"], sending: ["sent"] } })',
			),
		).toEqual({
			initial: "queued",
			terminal: ["sent"],
			transitions: { queued: ["sending"], sending: ["sent"] },
		})
	})

	it("accepts the cheap half — terminal only", () => {
		expect(extractStates('c.enum("status", ["a", "b"], { terminal: ["b"] })')).toEqual({
			initial: null,
			terminal: ["b"],
			transitions: null,
		})
	})

	it("reads a machine next to a const value list", () => {
		expect(extractStates('c.enum("status", STATUSES, { terminal: ["done"] })')).toEqual({
			initial: null,
			terminal: ["done"],
			transitions: null,
		})
	})

	it("returns null when there is no third argument, or the object is empty", () => {
		expect(extractStates('c.enum("status", ["a", "b"])')).toBeNull()
		expect(extractStates('c.enum("status", ["a"], {})')).toBeNull()
	})

	it("ignores a non-enum column whose braces look similar", () => {
		expect(extractStates('c.text("name", { max: 10, min: 1 })')).toBeNull()
	})
})

describe("extractConstraints does not swallow a state machine", () => {
	it("returns an empty map for c.enum, even when a third argument is present", () => {
		expect(extractConstraints('c.enum("status", ["a", "b"], { terminal: ["b"], private: true })')).toEqual({})
	})
})

describe("extractLength", () => {
	it("extracts from max constraint", () => {
		expect(extractLength('c.text("name", { max: 100 })')).toBe(100)
	})

	it("extracts from positional parameter", () => {
		expect(extractLength('c.text("name", 50)')).toBe(50)
	})

	it("returns null when no length", () => {
		expect(extractLength('c.text("name")')).toBeNull()
	})
})

describe("isTableDefinition", () => {
	it("returns true for createTable call", () => {
		expect(isTableDefinition('createTable("user", { ... })')).toBe(true)
	})

	it("returns false for other expressions", () => {
		expect(isTableDefinition("someFunction()")).toBe(false)
	})
})

describe("extractJsonSchemaImports", () => {
	it("extracts z.infer<typeof schema> patterns", () => {
		const raw = "z.infer<typeof mySchema> & z.infer<typeof otherSchema>"
		expect(extractJsonSchemaImports(raw)).toEqual(["mySchema", "otherSchema"])
	})

	it("returns empty for no matches", () => {
		expect(extractJsonSchemaImports('c.text("name")')).toEqual([])
	})
})

describe("extractConstraints", () => {
	it("extracts parameter-based constraints", () => {
		const result = extractConstraints('c.text("email", { min: 5, max: 254, email: true })')
		expect(result).toEqual({ email: true, max: 254, min: 5 })
	})

	it("returns empty for no constraints", () => {
		expect(extractConstraints('c.text("name")')).toEqual({})
	})

	it("handles boolean false values", () => {
		const result = extractConstraints('c.text("name", { trim: false })')
		expect(result).toEqual({ trim: false })
	})

	it("handles string values", () => {
		const result = extractConstraints('c.text("phone", { pattern: "/^\\\\+[0-9]+$/" })')
		expect(result.pattern).toBeDefined()
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

describe("isTableDefinition", () => {
	it("recognises only the createTable form", () => {
		expect(isTableDefinition('createTable("post", {})')).toBe(true)
		expect(isTableDefinition('sqliteTable("post", {})')).toBe(false)
		expect(isTableDefinition("")).toBe(false)
	})
})

describe("extractJsonSchemaImports", () => {
	it("collects every z.infer reference in order", () => {
		expect(extractJsonSchemaImports("z.infer<typeof settingsSchema>")).toEqual(["settingsSchema"])
		expect(extractJsonSchemaImports("a: z.infer<typeof aSchema>, b: z.infer<typeof bSchema>")).toEqual([
			"aSchema",
			"bSchema",
		])
	})

	it("returns nothing when there is no reference", () => {
		expect(extractJsonSchemaImports("z.string()")).toEqual([])
		expect(extractJsonSchemaImports("")).toEqual([])
	})
})

describe("buildIdentifierValueMap", () => {
	it("skips a module that cannot be resolved rather than throwing", () => {
		const map = buildIdentifierValueMap(new Map([["patterns", "./definitely-not-here"]]), process.cwd())
		expect(map.size).toBe(0)
	})

	it("returns an empty map for no imports", () => {
		expect(buildIdentifierValueMap(new Map(), process.cwd()).size).toBe(0)
	})
})

describe("extractConstraints — value forms", () => {
	it("reads the type-argument form as well as the parameter form", () => {
		expect(extractConstraints('c.text<{ max: 10 }>("name")')).toEqual({ max: 10 })
		expect(extractConstraints('c.text("name", { max: 10 })')).toEqual({ max: 10 })
	})

	it("returns nothing when there is no constraint object", () => {
		expect(extractConstraints('c.text("name")')).toEqual({})
		expect(extractConstraints("not a column at all")).toEqual({})
	})

	it("parses booleans, integers and both quote styles", () => {
		expect(extractConstraints(`c.text("n", { trim: true, private: false, max: 42, a: "x", b: 'y' })`)).toEqual({
			a: "x",
			b: "y",
			max: 42,
			private: false,
			trim: true,
		})
	})

	it("keeps a regex literal intact despite its braces and commas", () => {
		const result = extractConstraints(String.raw`c.text("n", { pattern: /^\+[1-9]\d{7,14}$/, max: 16 })`)
		expect(result["max"]).toBe(16)
		expect(String(result["pattern"])).toContain("7,14")
	})

	it("un-escapes doubled backslashes in a quoted pattern", () => {
		const result = extractConstraints(String.raw`c.text("n", { pattern: "/^\\d+$/" })`)
		expect(result["pattern"]).toBe(String.raw`/^\d+$/`)
	})

	it("ignores a fragment with no colon", () => {
		expect(extractConstraints('c.text("n", { justAKey })')).toEqual({})
	})

	it("resolves a dotted identifier through the value map", () => {
		setIdentifierValueMap(new Map([["patterns.LOCALE", "/^[a-z]{2}$/"]]))
		expect(extractConstraints('c.text("n", { pattern: patterns.LOCALE })')["pattern"]).toBe("/^[a-z]{2}$/")
		setIdentifierValueMap(new Map())
	})

	it("passes an unresolved identifier through verbatim", () => {
		setIdentifierValueMap(new Map())
		expect(extractConstraints('c.text("n", { pattern: patterns.UNKNOWN })')["pattern"]).toBe("patterns.UNKNOWN")
	})

	it("returns nothing for an unbalanced constraint object", () => {
		expect(extractConstraints('c.text("n", { max: 10')).toEqual({})
	})
})
