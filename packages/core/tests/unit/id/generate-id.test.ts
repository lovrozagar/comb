import { describe, expect, it } from "vitest"
import { generateId, generateUlid } from "../../../src/id.ts"

describe("generateUlid", () => {
	it("returns 26-character string", () => {
		const ulid = generateUlid()
		expect(ulid).toHaveLength(26)
	})

	it("uses valid Crockford base32 characters", () => {
		const valid = /^[0123456789abcdefghjkmnpqrstvwxyz]{26}$/
		for (let i = 0; i < 100; i++) {
			expect(generateUlid()).toMatch(valid)
		}
	})

	it("is unique across calls", () => {
		const ids = new Set<string>()
		for (let i = 0; i < 1000; i++) {
			ids.add(generateUlid())
		}
		expect(ids.size).toBe(1000)
	})

	it("is lexicographically sortable by time", async () => {
		const first = generateUlid()
		await new Promise((r) => setTimeout(r, 2))
		const second = generateUlid()
		expect(first < second).toBe(true)
	})
})

describe("generateId", () => {
	it("returns prefix_ulid format", () => {
		const id = generateId("usr")
		expect(id).toMatch(/^usr_[0-9a-z]{26}$/)
	})

	it("uses the given prefix", () => {
		expect(generateId("org").startsWith("org_")).toBe(true)
		expect(generateId("prj").startsWith("prj_")).toBe(true)
		expect(generateId("bat").startsWith("bat_")).toBe(true)
	})

	it("generates unique IDs", () => {
		const ids = new Set<string>()
		for (let i = 0; i < 100; i++) {
			ids.add(generateId("test"))
		}
		expect(ids.size).toBe(100)
	})
})
