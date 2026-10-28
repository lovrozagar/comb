import { describe, expect, it } from "vitest"
import { generateId } from "./id.ts"
import { c as pgC } from "./pg/columns.ts"
import { c as sqliteC } from "./sqlite/columns.ts"

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

/* F55 of the 0.13.0 round: c.id refuses what generateId refuses, so the tables module fails where the app's first insert would */
describe("c.id's prefix, as generateId takes it (F55)", () => {
	it.each([
		["sqlite", sqliteC],
		["postgres", pgC],
	] as const)("refuses on %s each prefix generateId refuses, and takes each it takes", (_, c) => {
		for (const prefix of ["Org", "tag_v2", "memberships", "u", "1st", ""]) {
			expect(() => generateId(prefix)).toThrow()
			expect(() => c.id(prefix)).toThrow(
				`Invalid entity prefix "${prefix}": must be 2-10 lowercase alphanumeric chars starting with a letter`,
			)
		}
		for (const prefix of ["org", "usr", "membership", "a1"]) expect(() => c.id(prefix)).not.toThrow()
	})
})
