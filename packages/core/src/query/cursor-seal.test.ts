import { describe, expect, it } from "vitest"
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts"
import {
	assertCursorWired,
	cursorKey,
	isSealedShape,
	MIN_CURSOR_SECRET_BYTES,
	openSealed,
	seal,
} from "./cursor-seal.ts"

const KEYS = { cursorScope: "members:org_a", cursorSecret: "a-test-secret-of-at-least-32-bytes!!" }
const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array | null) => (data === null ? null : new TextDecoder().decode(data))
const hex = (data: Uint8Array) => [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("")
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** `cursor` with one byte of its decoded form changed at `at` */
function flipped(cursor: string, at: number): string {
	const raw = decodeBase64Url(cursor) as Uint8Array
	return encodeBase64Url(raw.map((byte, i) => (i === at ? byte ^ 1 : byte)))
}

describe("cursorKey: HKDF-SHA256 of the secret", () => {
	it("equals Web Crypto's HKDF-SHA256 with no salt and comb's info, 32 bytes", async () => {
		for (const secret of [KEYS.cursorSecret, "字".repeat(11), "x".repeat(200)]) {
			const ikm = await crypto.subtle.importKey("raw", bytes(secret), "HKDF", false, ["deriveBits"])
			const params = { hash: "SHA-256", info: bytes("comb cursor v1"), name: "HKDF", salt: new Uint8Array() }
			const expected = new Uint8Array(await crypto.subtle.deriveBits(params, ikm, 256))
			expect(hex(cursorKey(secret))).toBe(hex(expected))
		}
	})
})

describe("seal and openSealed", () => {
	it("opens what it sealed under the same secret and scope, and seals the same text differently each time", () => {
		const sealed = seal(bytes('{"i":1,"s":"","v":[]}'), KEYS)
		expect(sealed).toMatch(/^[\w-]+$/)
		expect(text(openSealed(sealed, KEYS))).toBe('{"i":1,"s":"","v":[]}')
		expect(seal(bytes('{"i":1,"s":"","v":[]}'), KEYS)).not.toBe(sealed)
	})

	it("is XChaCha20-Poly1305 under the derived key: version byte, 24-byte nonce, then the sealed text, the version and scope bound", () => {
		const sealed = decodeBase64Url(seal(bytes("plain"), KEYS)) as Uint8Array
		expect(sealed[0]).toBe(1)
		const aad = new Uint8Array([1, ...bytes(KEYS.cursorScope)])
		const opened = xchacha20poly1305(cursorKey(KEYS.cursorSecret), sealed.slice(1, 25), aad).decrypt(sealed.slice(25))
		expect(text(opened)).toBe("plain")
		expect(sealed.length).toBe(1 + 24 + 5 + 16)
	})

	it("opens nothing under another scope or secret, or minted by a client with neither", () => {
		const sealed = seal(bytes("plain"), KEYS)
		expect(openSealed(sealed, { ...KEYS, cursorScope: "members:org_b" })).toBeNull()
		expect(openSealed(sealed, { ...KEYS, cursorScope: "members:org_a " })).toBeNull()
		expect(openSealed(sealed, { ...KEYS, cursorSecret: `${KEYS.cursorSecret}?` })).toBeNull()
		/* a client's own XChaCha20-Poly1305 under a key of its choosing */
		const nonce = new Uint8Array(24)
		const forged = xchacha20poly1305(new Uint8Array(32), nonce, new Uint8Array([1, ...bytes(KEYS.cursorScope)]))
		const mine = encodeBase64Url(new Uint8Array([1, ...nonce, ...forged.encrypt(bytes("plain"))]))
		expect(openSealed(mine, KEYS)).toBeNull()
	})
})

describe("openSealed on what no seal under these options wrote", () => {
	it("opens nothing with any byte changed, cut or added, or under another version", () => {
		const sealed = seal(bytes('{"i":1,"s":"","v":[]}'), KEYS)
		const length = (decodeBase64Url(sealed) as Uint8Array).length
		for (let at = 0; at < length; at++) expect(openSealed(flipped(sealed, at), KEYS)).toBeNull()
		const raw = decodeBase64Url(sealed) as Uint8Array
		expect(openSealed(encodeBase64Url(raw.slice(0, -1)), KEYS)).toBeNull()
		expect(openSealed(encodeBase64Url(new Uint8Array([...raw, 0])), KEYS)).toBeNull()
		expect(openSealed(encodeBase64Url(new Uint8Array([2, ...raw.slice(1)])), KEYS)).toBeNull()
	})

	it("opens nothing spelled another way for the same bytes, or that is no base64url", () => {
		/* 46 bytes leave 4 padding bits in the last character: setting one keeps the bytes */
		const sealed = seal(bytes("plain"), KEYS)
		const last = BASE64URL.indexOf(sealed.at(-1) as string)
		const respelled = `${sealed.slice(0, -1)}${BASE64URL[last ^ 1]}`
		expect(decodeBase64Url(respelled)).toBeNull()
		expect(openSealed(respelled, KEYS)).toBeNull()
		for (const odd of ["", "A", `${sealed}=`, `${sealed.slice(0, 10)}+${sealed.slice(11)}`, "!".repeat(64)])
			expect(openSealed(odd, KEYS)).toBeNull()
	})

	it("seals one payload under two scopes as unrelated bytes: a fresh nonce each, so no position agrees beyond chance", () => {
		const payload = bytes(JSON.stringify({ i: 7, s: "salary.desc.nullsfirst", v: ["x".repeat(200)] }))
		const [a, b] = ["members:org_a", "members:org_b"].map(
			(cursorScope) => decodeBase64Url(seal(payload, { ...KEYS, cursorScope })) as Uint8Array,
		) as [Uint8Array, Uint8Array]
		expect(a.length).toBe(b.length)
		/* about 1 of every 256 positions agrees by chance; 8 of these 250 would be a one in 10^8 event */
		const agreeing = a.slice(1).filter((byte, i) => byte === b[i + 1]).length
		expect(agreeing).toBeLessThan(8)
		expect(openSealed(encodeBase64Url(a), { ...KEYS, cursorScope: "members:org_b" })).toBeNull()
	})

	it("hands a client none of the sealed text: no run of it appears in the cursor, decoded or not", () => {
		const secret = "salary=99000;email=ann@corp.test"
		const sealed = seal(bytes(secret), KEYS)
		const raw = String.fromCharCode(...(decodeBase64Url(sealed) as Uint8Array))
		for (let at = 0; at + 4 <= secret.length; at++) {
			const run = secret.slice(at, at + 4)
			expect(raw).not.toContain(run)
			expect(sealed).not.toContain(run)
			expect(sealed).not.toContain(encodeBase64Url(bytes(run)).slice(0, 4))
		}
	})
})

describe("isSealedShape: what a list schema can check without the secret", () => {
	it("takes a sealed cursor and refuses what no seal writes", () => {
		expect(isSealedShape(seal(bytes("{}"), KEYS))).toBe(true)
		const raw = decodeBase64Url(seal(bytes("{}"), KEYS)) as Uint8Array
		expect(isSealedShape(encodeBase64Url(new Uint8Array([2, ...raw.slice(1)])))).toBe(false)
		expect(isSealedShape(encodeBase64Url(raw.slice(0, 41)))).toBe(false)
		for (const odd of ["", "eyJ4IjoxfQ.abc", "!".repeat(64)]) expect(isSealedShape(odd)).toBe(false)
	})
})

describe("assertCursorWired", () => {
	it("throws a 500 for a secret under 32 UTF-8 bytes or no string, and for an empty or missing scope", () => {
		expect(MIN_CURSOR_SECRET_BYTES).toBe(32)
		const unwired = expect.objectContaining({ errorKey: "cursor_not_wired", status: 500 })
		expect(() => assertCursorWired({ ...KEYS, cursorSecret: "x".repeat(31) })).toThrow(unwired)
		expect(() => assertCursorWired({ ...KEYS, cursorSecret: undefined as unknown as string })).toThrow(unwired)
		expect(() => assertCursorWired({ ...KEYS, cursorScope: "" })).toThrow(unwired)
		expect(() => assertCursorWired({ cursorSecret: KEYS.cursorSecret } as typeof KEYS)).toThrow(unwired)
		expect(() => assertCursorWired(undefined as unknown as typeof KEYS)).toThrow(unwired)
		expect(() => seal(bytes("p"), { ...KEYS, cursorScope: "" })).toThrow(unwired)
		expect(() => openSealed("x", { ...KEYS, cursorSecret: "short" })).toThrow(unwired)
		/* eleven three-byte characters are 33 bytes */
		expect(() => assertCursorWired({ ...KEYS, cursorSecret: "字".repeat(11) })).not.toThrow()
	})
})
