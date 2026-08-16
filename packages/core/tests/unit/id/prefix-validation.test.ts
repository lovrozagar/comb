import { describe, expect, it } from "vitest"
import { generateId } from "../../../src/id.ts"

describe("generateId prefix validation", () => {
	it("accepts valid 2-char prefix", () => {
		expect(() => generateId("ab")).not.toThrow()
	})

	it("accepts valid 3-char prefix", () => {
		const id = generateId("usr")
		expect(id).toMatch(/^usr_/)
	})

	it("accepts valid 10-char prefix", () => {
		expect(() => generateId("abcdefghij")).not.toThrow()
	})

	it("accepts prefix with digits after first char", () => {
		expect(() => generateId("u2f")).not.toThrow()
	})

	it("rejects single char prefix", () => {
		expect(() => generateId("a")).toThrow("Invalid entity prefix")
	})

	it("rejects prefix longer than 10 chars", () => {
		expect(() => generateId("abcdefghijk")).toThrow("Invalid entity prefix")
	})

	it("rejects prefix starting with digit", () => {
		expect(() => generateId("1abc")).toThrow("Invalid entity prefix")
	})

	it("rejects uppercase prefix", () => {
		expect(() => generateId("USR")).toThrow("Invalid entity prefix")
	})

	it("rejects prefix with special chars", () => {
		expect(() => generateId("us-r")).toThrow("Invalid entity prefix")
		expect(() => generateId("us_r")).toThrow("Invalid entity prefix")
	})

	it("rejects empty prefix", () => {
		expect(() => generateId("")).toThrow("Invalid entity prefix")
	})
})
