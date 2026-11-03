import { describe, expect, it } from "vitest"
import * as z from "zod"
import { passwordText } from "./password-text.ts"

/* C1, C4 of r21: the plaintext policy a password column's hash cannot carry, after NIST SP 800-63B rev 4 §3.1.1.2 */

const accepts = (schema: z.ZodType, value: string): boolean => schema.safeParse(value).success

/* "é" decomposed: two code points that NFC writes as one */
const NFD_E = "é"

describe("passwordText, which sets a password", () => {
	it("takes any storable passphrase of 15 to 128 characters, Unicode and CJK included", () => {
		const set = passwordText()
		expect(accepts(set, "correct horse battery staple")).toBe(true)
		expect(accepts(set, "ünïcödé pässwörd")).toBe(true)
		expect(accepts(set, "我的密码是一句很长的中文句子啊")).toBe(true)
		expect(accepts(set, "🔑".repeat(15))).toBe(true)
		expect(accepts(set, "x".repeat(128))).toBe(true)
		expect(accepts(set, "x".repeat(14))).toBe(false)
		expect(accepts(set, "x".repeat(129))).toBe(false)
		expect(accepts(set, `${"x".repeat(15)}\u0000`)).toBe(false)
	})

	it("counts by code point, so 15 astral characters are 15, not 30", () => {
		expect(accepts(passwordText({ max: 15 }), "🔑".repeat(15))).toBe(true)
		expect(accepts(passwordText({ max: 15 }), "🔑".repeat(16))).toBe(false)
	})

	it("normalizes to NFC, then counts, and trims nothing", () => {
		const set = passwordText()
		expect(set.parse(NFD_E.repeat(15))).toBe("é".repeat(15))
		/* sixteen code points as typed, eight after NFC */
		expect(accepts(set, NFD_E.repeat(8))).toBe(false)
		expect(set.parse("  padded passphrase  ")).toBe("  padded passphrase  ")
	})

	it("takes a min and a max of the app's own, as for a password used only with a second factor", () => {
		const second = passwordText({ max: 64, min: 8 })
		expect(accepts(second, "eightchr")).toBe(true)
		expect(accepts(second, "sevench")).toBe(false)
		expect(accepts(second, "x".repeat(65))).toBe(false)
	})

	it.each([
		[{ min: 20, max: 10 }, "passwordText's min 20 is past its max 10"],
		[{ min: -1 }, "passwordText's min is a whole number from 0, not -1"],
		[{ max: 1.5 }, "passwordText's max is a whole number from 1, not 1.5"],
	])("refuses options that hold no password: %o", (options, said) => {
		expect(() => passwordText(options)).toThrow(new TypeError(said))
	})
})

describe("passwordText under bcrypt", () => {
	it("refuses past 72 UTF-8 bytes, which bcrypt reads no further than, and counts nothing else as bytes", () => {
		const bcrypt = passwordText({ hash: "bcrypt" })
		const ascii73 = "x".repeat(73)
		expect(accepts(passwordText(), ascii73)).toBe(true)
		expect(accepts(bcrypt, ascii73)).toBe(false)
		expect(accepts(bcrypt, "x".repeat(72))).toBe(true)
		/* 25 characters of 3-byte text: 75 bytes, well under 128 characters */
		const cjk25 = "密".repeat(25)
		expect(accepts(passwordText(), cjk25)).toBe(true)
		expect(accepts(bcrypt, cjk25)).toBe(false)
		expect(accepts(bcrypt, "密".repeat(24))).toBe(true)
	})
})

describe("passwordText's JSON Schema", () => {
	it("publishes its bounds in code points, its storable rule, and bcrypt's bytes", () => {
		expect(z.toJSONSchema(passwordText())).toMatchObject({
			maxLength: 128,
			minLength: 15,
			type: "string",
			"x-comb-text": "no U+0000 or unpaired surrogate",
		})
		expect(z.toJSONSchema(passwordText())).not.toHaveProperty("x-comb-maxBytes")
		expect(z.toJSONSchema(passwordText({ hash: "bcrypt" }))).toMatchObject({ "x-comb-maxBytes": 72 })
		expect(z.toJSONSchema(passwordText({ hash: "bcrypt" }), { io: "input" })).toMatchObject({ minLength: 15 })
	})
})

describe("passwordText.typed, which reads a password typed to sign in", () => {
	it("holds only the max, so a password set before a minimum still signs in", () => {
		expect(accepts(passwordText.typed(), "ninechars")).toBe(true)
		expect(accepts(passwordText(), "ninechars")).toBe(false)
		expect(accepts(passwordText.typed(), "")).toBe(true)
		expect(accepts(passwordText.typed(), "x".repeat(129))).toBe(false)
		expect(accepts(passwordText.typed({ max: 10 }), "x".repeat(11))).toBe(false)
		expect(accepts(passwordText.typed({ hash: "bcrypt" }), "x".repeat(73))).toBe(false)
		expect(z.toJSONSchema(passwordText.typed())).not.toHaveProperty("minLength")
	})

	it("gives a password typed as NFD the string the set form gives its NFC spelling", () => {
		const typed = NFD_E.repeat(15)
		expect(passwordText.typed().parse(typed)).toBe(passwordText().parse("é".repeat(15)))
	})
})
