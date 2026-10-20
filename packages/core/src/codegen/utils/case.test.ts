import { describe, expect, it } from "vitest"
import {
	camelToKebab,
	propertyAccess,
	propertyName,
	snakeToCamel,
	snakeToPascal,
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
