import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { contractReader } from "./__fixtures__/contract-reader.ts"
import { parseField } from "./codegen/__fixtures__/runtime.ts"
import { SHARED_META_KEYS, SHARED_META_VALUES } from "./codegen/generators/dtos/example-meta.ts"
import { generateFieldSchema } from "./codegen/generators/dtos/field-schema.ts"
import { passwordText } from "./password-text.ts"
import { isStorableText } from "./storable-text.ts"

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
		/* CD10 of r22b: every code point is a byte at least, so past 72 no password is one bcrypt reads */
		[{ hash: "bcrypt", min: 73 }, "passwordText's min 73 leaves no password bcrypt reads: bcrypt reads 72 bytes"],
		[
			{ hash: "bcrypt", max: 128, min: 80 },
			"passwordText's min 80 leaves no password bcrypt reads: bcrypt reads 72 bytes",
		],
	] as const)("refuses options that hold no password: %o", (options, said) => {
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
	it("publishes its bounds in code points of the NFC form, its storable rule, and bcrypt's text bytes", () => {
		expect(z.toJSONSchema(passwordText())).toMatchObject({
			maxLength: 128,
			minLength: 15,
			type: "string",
			"x-comb-text": "no U+0000 or unpaired surrogate",
			"x-comb-transform": ["nfc"],
		})
		expect(z.toJSONSchema(passwordText())).not.toHaveProperty("x-comb-maxUtf8Bytes")
		expect(z.toJSONSchema(passwordText({ hash: "bcrypt" }))).toMatchObject({ "x-comb-maxUtf8Bytes": 72 })
		expect(z.toJSONSchema(passwordText({ hash: "bcrypt" }))).not.toHaveProperty("x-comb-maxBytes")
		expect(z.toJSONSchema(passwordText({ hash: "bcrypt" }), { io: "input" })).toMatchObject({ minLength: 15 })
	})
})

/*
 * C1, C2, C3 of r22 and CD10 of r22b: a reader that applies each published key as meta-contract §2.1
 * defines it, and nothing else, agrees with comb's own parse; the bounds are zod's own, so a short or
 * long password is the too_small or too_big issue every other comb length is
 */

const utf8 = (value: string): number => new TextEncoder().encode(value).length

const published = (schema: z.ZodType): Record<string, unknown> =>
	z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>

/* bcrypt's edge, as ASCII and with a quote JSON escapes */
const EDGE = [
	"x".repeat(71),
	"x".repeat(72),
	"x".repeat(73),
	`"${"x".repeat(68)}"`,
	`"${"x".repeat(70)}"`,
	`${"x".repeat(20)}\\${"x".repeat(20)}`,
]

describe("passwordText's published keys, read as meta-contract §2.1 defines them (C1, C2; sibling: a c.json field's x-comb-maxBytes)", () => {
	it.each([
		["passwordText()", passwordText()],
		['passwordText({ hash: "bcrypt" })', passwordText({ hash: "bcrypt" })],
		["passwordText.typed()", passwordText.typed()],
		['passwordText.typed({ hash: "bcrypt" })', passwordText.typed({ hash: "bcrypt" })],
	])("%s: the reader agrees with safeParse at 71, 72 and 73 bytes and on a quote", (_, schema) => {
		for (const value of EDGE)
			expect(contractReader(published(schema), value), JSON.stringify(value)).toBe(schema.safeParse(value).success)
	})

	it("bounds the NFC form: 128 é typed as NFD pass comb and the reader, 8 fail both", () => {
		const long = NFD_E.repeat(128)
		const short = NFD_E.repeat(8)
		expect(passwordText().safeParse(long).success).toBe(true)
		expect(contractReader(published(passwordText()), long)).toBe(true)
		for (const schema of [passwordText(), passwordText({ hash: "bcrypt" })]) {
			expect(schema.safeParse(short).success).toBe(false)
			expect(contractReader(published(schema), short)).toBe(false)
		}
		expect(contractReader(published(passwordText.typed()), NFD_E.repeat(128))).toBe(true)
		expect(contractReader(published(passwordText.typed()), NFD_E.repeat(129))).toBe(false)
	})

	it("holds bcrypt's bytes to the NFC form too: 36 é typed as NFD are 72 bytes after NFC", () => {
		const schema = passwordText({ hash: "bcrypt" })
		const typed = NFD_E.repeat(36)
		expect(utf8(typed)).toBe(108)
		expect(schema.safeParse(typed).success).toBe(true)
		expect(contractReader(published(schema), typed)).toBe(true)
		expect(contractReader(published(schema), NFD_E.repeat(37))).toBe(false)
	})

	it("sibling: codegen's x-comb-maxBytes on a c.json field still measures the JSON text, quotes included", () => {
		const Doc = z.object({ a: z.string() })
		const field = parseField("doc", 'c.json("doc", Doc, { maxBytes: 9 })', { scope: { Doc } })
		const code = generateFieldSchema(field, "create", {
			imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
		}) as string
		const meta = new Function(
			`return {${SHARED_META_KEYS.map((key) => `${key}: ${SHARED_META_VALUES[key]}`).join(",")}}`,
		)()
		const schema = new Function("z", "comb", "_m", "Doc", ts.transpile(`return ${code}`))(
			z,
			{ isStorableText },
			meta,
			Doc,
		) as z.ZodType
		const keys = published(schema)
		expect(keys["x-comb-maxBytes"]).toBe(9)
		for (const value of [{ a: "x" }, { a: "xy" }, { a: '"' }])
			expect(contractReader(keys, value), JSON.stringify(value)).toBe(schema.safeParse(value).success)
		expect(schema.safeParse({ a: "x" }).success).toBe(true)
		expect(schema.safeParse({ a: '"' }).success).toBe(false)
	})
})

/** The issues `schema` gives `value`, none when it passes */
const issue = (schema: z.ZodType, value: string) => {
	const result = schema.safeParse(value)
	return result.success ? undefined : result.error.issues
}

describe("passwordText's issues are zod's own length issues (C3; sibling: passwordText.typed)", () => {
	it("gives a short value too_small with its minimum, a long one too_big with its maximum", () => {
		expect(issue(passwordText(), "short")).toEqual([expect.objectContaining({ code: "too_small", minimum: 15 })])
		expect(issue(passwordText(), "x".repeat(129))).toEqual([expect.objectContaining({ code: "too_big", maximum: 128 })])
		expect(issue(passwordText.typed({ max: 10 }), "x".repeat(11))).toEqual([
			expect.objectContaining({ code: "too_big", maximum: 10 }),
		])
	})

	it("gives a value past bcrypt's 72 bytes too_big with a maximum of 72, set or typed", () => {
		for (const schema of [passwordText({ hash: "bcrypt" }), passwordText.typed({ hash: "bcrypt" })])
			expect(issue(schema, "x".repeat(73))).toEqual([
				expect.objectContaining({ code: "too_big", maximum: 72, origin: "string" }),
			])
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
