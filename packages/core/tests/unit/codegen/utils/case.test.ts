import { describe, expect, it } from "vitest"
import { camelToKebab, snakeToCamel, snakeToPascal, toScreamingSnakeCase } from "../../../../src/codegen/utils/case.ts"

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
