/**
 * A cursor's seal: XChaCha20-Poly1305 (@noble/ciphers, synchronous, so parsing and paginating
 * stay sync) under a key HKDF-SHA256 derives from the app's cursor secret. The payload is
 * encrypted, not only signed, so a client reads none of the sort values it carries, a column the
 * endpoint never selects included. The version byte and the list's scope (its route and tenant)
 * are the associated data, so a cursor minted in one list, or one tenant, opens in no other.
 *
 * On the wire: base64url of the version byte, a random 24-byte nonce, then the ciphertext and its
 * 16-byte tag. Anything else, spelled another way included, opens to nothing.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts"

/** What seals and opens the cursors of one list: the app's secret, and the list's scope (route plus tenant) */
type CursorOptions = {
	cursorScope: string
	cursorSecret: string
	/**
	 * "exact" when the driver reads a SQLite REAL's ±Infinity back as Infinity (a local libsql file,
	 * bun:sqlite), so a null cursor is a real NULL and a list whose NULL anchor is deleted resumes
	 * right after it. Unset, as on D1, which reads ±Infinity as null, such a list resumes from the
	 * earliest value the null may stand for, repeating rows and skipping none (U24).
	 */
	nonFinite?: "exact" | undefined
}

/** The shortest secret a cursor is sealed under, in UTF-8 bytes: the key's length */
const MIN_CURSOR_SECRET_BYTES = 32

const VERSION = 1
const NONCE_BYTES = 24
const TAG_BYTES = 16
/* the shortest payload a cursor holds is longer than one byte */
const MIN_SEALED_BYTES = 1 + NONCE_BYTES + TAG_BYTES + 2
const INFO = /* @__PURE__ */ new TextEncoder().encode("comb cursor v1")

/** A wiring mistake in a list's cursor options: a 500 */
function notWired(cause: string): CombError {
	return new CombError({ cause, errorKey: combErrorKeys.CURSOR_NOT_WIRED, status: "internal_server_error" })
}

/** The secret's UTF-8 bytes; a 500 when it is shorter than the minimum */
function secretBytes(secret: unknown): Uint8Array {
	const bytes = new TextEncoder().encode(typeof secret === "string" ? secret : "")
	if (bytes.length >= MIN_CURSOR_SECRET_BYTES) return bytes
	throw notWired(
		`the cursor secret must be at least ${MIN_CURSOR_SECRET_BYTES} bytes of UTF-8; pass the app's CURSOR_SECRET`,
	)
}

// lru-cache: the key of the one secret last asked for; a worker holds one secret, so HKDF runs once for it
let derived: { key: Uint8Array; secret: string } | undefined

/** The 32-byte key HKDF-SHA256 derives from `secret`, with no salt and comb's info */
function cursorKey(secret: string): Uint8Array {
	if (derived?.secret === secret) return derived.key
	const key = hkdf(sha256, secretBytes(secret), undefined, INFO, 32)
	derived = { key, secret }
	return key
}

/** The key and associated data for `options`; a 500 when either is missing or the secret is short */
function sealing(options: CursorOptions): { aad: Uint8Array; key: Uint8Array } {
	const { cursorScope, cursorSecret } = options ?? {}
	const key = cursorKey(cursorSecret)
	if (typeof cursorScope !== "string" || cursorScope === "")
		throw notWired("a cursor needs the list's scope, its route and tenant; pass cursorScope")
	return { aad: new Uint8Array([VERSION, ...new TextEncoder().encode(cursorScope)]), key }
}

/** Throw the 500 sealing throws when `options` cannot seal a cursor */
function assertCursorWired(options: CursorOptions): void {
	sealing(options)
}

/* the size a plaintext is padded up to a multiple of, so a cursor's length tells no value's length within it */
const BUCKET_BYTES = 256

/**
 * `plaintext` sealed under `options`, as base64url, padded with spaces up to a multiple of 256
 * bytes first (U9): AEAD hides the bytes, not their count, and a cursor carries a hidden column's
 * value too. openSealed strips them: what seal takes ends in no space of its own.
 */
function seal(plaintext: Uint8Array, options: CursorOptions): string {
	const { aad, key } = sealing(options)
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
	const padded = new Uint8Array(Math.ceil(Math.max(plaintext.length, 1) / BUCKET_BYTES) * BUCKET_BYTES).fill(0x20)
	padded.set(plaintext)
	const sealed = xchacha20poly1305(key, nonce, aad).encrypt(padded)
	return encodeBase64Url(new Uint8Array([VERSION, ...nonce, ...sealed]))
}

/** The bytes `cursor` holds when it has a sealed cursor's shape, or null */
function sealedBytes(cursor: string): Uint8Array | null {
	const raw = decodeBase64Url(cursor)
	return raw !== null && raw.length >= MIN_SEALED_BYTES && raw[0] === VERSION ? raw : null
}

/** Whether `cursor` has a sealed cursor's shape: what a check without the secret can know */
const isSealedShape = (cursor: string): boolean => sealedBytes(cursor) !== null

/** What `cursor` holds, opened under `options`; null when it was not sealed under both */
function openSealed(cursor: string, options: CursorOptions): Uint8Array | null {
	const { aad, key } = sealing(options)
	const raw = sealedBytes(cursor)
	if (raw === null) return null
	try {
		const padded = xchacha20poly1305(key, raw.slice(1, 1 + NONCE_BYTES), aad).decrypt(raw.slice(1 + NONCE_BYTES))
		/* the padding seal adds; a cursor's JSON ends in no space of its own */
		let end = padded.length
		while (end > 0 && padded[end - 1] === 0x20) end--
		return padded.slice(0, end)
	} catch {
		// reason: a tag that does not verify is a forged, tampered or foreign cursor; callers answer invalid_cursor
		return null
	}
}

export { assertCursorWired, cursorKey, type CursorOptions, isSealedShape, MIN_CURSOR_SECRET_BYTES, openSealed, seal }
