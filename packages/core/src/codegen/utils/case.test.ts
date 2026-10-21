import { describe, expect, it } from "vitest"
import {
	camelToKebab,
	commentText,
	dbIdentifiers,
	propertyAccess,
	propertyName,
	snakeToCamel,
	snakeToPascal,
	sqlIdentifier,
	stringLiteral,
	toScreamingSnakeCase,
} from "./case.ts"

describe("snakeToCamel", () => {
	it("converts basic snake_case", () => {
		expect(snakeToCamel("user_name")).toBe("userName")
	})
	it("handles multiple underscores", () => {
		expect(snakeToCamel("created_at_date")).toBe("createdAtDate")
	})
	it("returns single word unchanged", () => {
		expect(snakeToCamel("name")).toBe("name")
	})
	it("handles leading lowercase", () => {
		expect(snakeToCamel("api_key_id")).toBe("apiKeyId")
	})
})

describe("snakeToPascal", () => {
	it("converts to PascalCase", () => {
		expect(snakeToPascal("user_account")).toBe("UserAccount")
	})
	it("handles single word", () => {
		expect(snakeToPascal("user")).toBe("User")
	})
})

describe("camelToKebab", () => {
	it("converts camelCase to kebab-case", () => {
		expect(camelToKebab("userName")).toBe("user-name")
	})
	it("handles multiple capitals", () => {
		expect(camelToKebab("userAccountName")).toBe("user-account-name")
	})
})

describe("toScreamingSnakeCase", () => {
	it("converts camelCase to SCREAMING_SNAKE", () => {
		expect(toScreamingSnakeCase("userName")).toBe("USER_NAME")
	})
	it("converts snake_case to SCREAMING_SNAKE", () => {
		expect(toScreamingSnakeCase("user_name")).toBe("USER_NAME")
	})
})

describe("propertyName", () => {
	it("leaves an identifier bare and quotes any other key", () => {
		expect(propertyName("org_id")).toBe("org_id")
		expect(propertyName("org_id,email")).toBe('"org_id,email"')
		expect(propertyName("display-name")).toBe('"display-name"')
	})
})

describe("propertyAccess", () => {
	it("reads an identifier key with a dot and any other key with brackets", () => {
		expect(propertyAccess("t", "org_id")).toBe("t.org_id")
		expect(propertyAccess("t", "display-name")).toBe('t["display-name"]')
	})
})

describe("stringLiteral", () => {
	it("writes a plain name as it is and escapes a quote or a backslash", () => {
		expect(stringLiteral("user")).toBe('"user"')
		expect(stringLiteral('quo"ted \\')).toBe('"quo\\"ted \\\\"')
	})
})

describe("commentText", () => {
	it("keeps a name from closing the block comment it is written into", () => {
		expect(commentText("user")).toBe("user")
		expect(commentText("a */ b")).toBe("a * / b")
	})
})

describe("sqlIdentifier", () => {
	it("leaves a plain identifier bare and double-quotes any other name, its quotes doubled", () => {
		expect(sqlIdentifier("user_id")).toBe("user_id")
		expect(sqlIdentifier('quo"ted')).toBe('"quo""ted"')
		expect(sqlIdentifier("price$")).toBe('"price$"')
	})
})

describe("dbIdentifiers (F1)", () => {
	it("camel-cases a name across what no identifier holds, and keeps one that already is", () => {
		expect(dbIdentifiers("my-db")).toEqual({ camel: "myDb", constant: "MY_DB", pascal: "MyDb" })
		expect(dbIdentifiers("core")).toEqual({ camel: "core", constant: "CORE", pascal: "Core" })
		expect(dbIdentifiers("appCore")).toEqual({ camel: "appCore", constant: "APP_CORE", pascal: "AppCore" })
		expect(dbIdentifiers("a b.c")).toMatchObject({ camel: "aBC" })
	})

	it("throws, naming the database, when no identifier can be made of it", () => {
		for (const name of ["1db", "", "--"]) expect(() => dbIdentifiers(name)).toThrow(`database "${name}"`)
	})
})
