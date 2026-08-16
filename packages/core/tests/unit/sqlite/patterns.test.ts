import { describe, expect, it } from "vitest"
import { patterns } from "../../../src/sqlite/patterns.ts"

describe("patterns", () => {
	describe("COUNTRY_ALPHA2", () => {
		const re = new RegExp(patterns.COUNTRY_ALPHA2.slice(1, -1))

		it("matches valid country codes", () => {
			expect(re.test("US")).toBe(true)
			expect(re.test("DE")).toBe(true)
			expect(re.test("GB")).toBe(true)
		})

		it("rejects invalid codes", () => {
			expect(re.test("us")).toBe(false)
			expect(re.test("USA")).toBe(false)
			expect(re.test("U")).toBe(false)
			expect(re.test("")).toBe(false)
		})
	})

	describe("E164_PHONE", () => {
		const re = new RegExp(patterns.E164_PHONE.slice(1, -1))

		it("matches valid phone numbers", () => {
			expect(re.test("+14155552671")).toBe(true)
			expect(re.test("+491701234567")).toBe(true)
		})

		it("rejects invalid phone numbers", () => {
			expect(re.test("14155552671")).toBe(false)
			expect(re.test("+0123")).toBe(false)
			expect(re.test("")).toBe(false)
		})
	})

	describe("IANA_TIMEZONE", () => {
		const re = new RegExp(patterns.IANA_TIMEZONE.slice(1, -1))

		it("matches valid timezones", () => {
			expect(re.test("America/New_York")).toBe(true)
			expect(re.test("Europe/Berlin")).toBe(true)
			expect(re.test("UTC")).toBe(true)
		})

		it("rejects invalid timezones", () => {
			expect(re.test("")).toBe(false)
			expect(re.test("123")).toBe(false)
		})
	})

	describe("LOCALE", () => {
		const re = new RegExp(patterns.LOCALE.slice(1, -1))

		it("matches valid locales", () => {
			expect(re.test("en")).toBe(true)
			expect(re.test("pt-BR")).toBe(true)
			expect(re.test("de-DE")).toBe(true)
		})

		it("rejects invalid locales", () => {
			expect(re.test("EN")).toBe(false)
			expect(re.test("english")).toBe(false)
			expect(re.test("")).toBe(false)
			expect(re.test("pt-br")).toBe(false)
		})
	})
})
