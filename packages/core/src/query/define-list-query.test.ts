import { describe, expect, it } from "vitest"
import { defineListQuery } from "./define-list-query.ts"
import { PAGINATION_DEFAULTS } from "./schema-limits.ts"

describe("defineListQuery", () => {
	it("builds capabilities from config", () => {
		const { capabilities } = defineListQuery({
			filter: { status: "enum" },
			search: ["title"],
			sort: ["createdAt", "name"],
		})

		expect(capabilities.filterFields).toEqual({ status: "enum" })
		expect(capabilities.sortFields.has("createdAt")).toBe(true)
		expect(capabilities.searchFields.has("title")).toBe(true)
		expect(capabilities.pagination.defaultLimit).toBe(PAGINATION_DEFAULTS.defaultLimit)
	})

	it("uses custom pagination", () => {
		const { capabilities } = defineListQuery({
			pagination: { defaultLimit: 50, maxLimit: 200 },
			sort: ["id"],
		})
		expect(capabilities.pagination.defaultLimit).toBe(50)
		expect(capabilities.pagination.maxLimit).toBe(200)
	})
})
