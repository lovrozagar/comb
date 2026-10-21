import { describe, expect, it } from "vitest"
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts"

describe("base64url", () => {
	it("round-trips every byte, unpadded, with - and _ for + and /", () => {
		const all = Uint8Array.from({ length: 256 }, (_, i) => i)
		const text = encodeBase64Url(all)
		expect(text).toMatch(/^[\w-]+$/)
		expect(decodeBase64Url(text)).toEqual(all)
		expect(encodeBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8")
		expect(decodeBase64Url("")).toEqual(new Uint8Array())
	})

	it("is null for text that is not base64url", () => {
		for (const text of ["a+b", "a/b", "a=", "a", "!!"]) expect(decodeBase64Url(text)).toBeNull()
	})
})
