import { describe, expect, it } from "vitest"
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts"
import { macOf, MIN_CURSOR_SECRET_BYTES, signPayload, verifyTag } from "./cursor-sign.ts"

const SECRET = "a-test-secret-of-at-least-32-bytes!!"
const bytes = (text: string) => new TextEncoder().encode(text)
const repeat = (byte: number, n: number) => new Uint8Array(n).fill(byte)
const hex = (data: Uint8Array) => [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/* RFC 4231 §4: HMAC-SHA-256 test cases 1, 2, 3 and 6 */
const RFC_4231 = [
	{
		data: bytes("Hi There"),
		key: repeat(0x0b, 20),
		mac: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
		n: 1,
	},
	{
		data: bytes("what do ya want for nothing?"),
		key: bytes("Jefe"),
		mac: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
		n: 2,
	},
	{
		data: repeat(0xdd, 50),
		key: repeat(0xaa, 20),
		mac: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
		n: 3,
	},
	{
		data: bytes("Test Using Larger Than Block-Size Key - Hash Key First"),
		key: repeat(0xaa, 131),
		mac: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
		n: 6,
	},
]

describe("macOf: HMAC-SHA256", () => {
	it.each(RFC_4231)("matches RFC 4231 test case $n", ({ data, key, mac }) => {
		expect(hex(macOf(key, data))).toBe(mac)
	})

	it("equals Web Crypto's HMAC-SHA256 on random keys and payloads", async () => {
		for (let round = 0; round < 20; round++) {
			const key = crypto.getRandomValues(new Uint8Array(32 + round))
			const data = crypto.getRandomValues(new Uint8Array(round * 37))
			const subtle = await crypto.subtle.importKey("raw", key, { hash: "SHA-256", name: "HMAC" }, false, ["sign"])
			const expected = new Uint8Array(await crypto.subtle.sign("HMAC", subtle, data))
			expect(hex(macOf(key, data))).toBe(hex(expected))
		}
	})
})

describe("signPayload and verifyTag", () => {
	it("tags the payload's exact bytes with the secret's UTF-8 bytes as the key, in base64url", () => {
		const tag = signPayload("eyJ4IjoxfQ", SECRET)
		expect(tag).toMatch(/^[\w-]{43}$/)
		expect(tag).toBe(encodeBase64Url(macOf(bytes(SECRET), bytes("eyJ4IjoxfQ"))))
		expect(verifyTag("eyJ4IjoxfQ", tag, SECRET)).toBe(true)
	})

	it("refuses a tampered payload, a tampered tag, a wrong secret and a tag of the wrong shape", () => {
		const tag = signPayload("eyJ4IjoxfQ", SECRET)
		expect(verifyTag("eyJ4IjoyfQ", tag, SECRET)).toBe(false)
		const flipped = encodeBase64Url((decodeBase64Url(tag) as Uint8Array).map((byte, i) => (i === 31 ? byte ^ 1 : byte)))
		expect(verifyTag("eyJ4IjoxfQ", flipped, SECRET)).toBe(false)
		expect(verifyTag("eyJ4IjoxfQ", tag, `${SECRET}?`)).toBe(false)
		for (const odd of ["", tag.slice(1), `${tag}A`, `${tag.slice(0, 42)}+`, "!".repeat(43)])
			expect(verifyTag("eyJ4IjoxfQ", odd, SECRET)).toBe(false)
	})

	it("throws a 500 for a secret under 32 bytes, counted in UTF-8, or one that is no string", () => {
		expect(MIN_CURSOR_SECRET_BYTES).toBe(32)
		const short = expect.objectContaining({ errorKey: "cursor_not_wired", status: 500 })
		expect(() => signPayload("p", "x".repeat(31))).toThrow(short)
		expect(() => verifyTag("p", "t", "x".repeat(31))).toThrow(short)
		expect(() => signPayload("p", undefined as unknown as string)).toThrow(short)
		/* eleven three-byte characters are 33 bytes */
		expect(() => signPayload("p", "字".repeat(11))).not.toThrow()
	})
})
