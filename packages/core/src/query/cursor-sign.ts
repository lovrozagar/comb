/**
 * A cursor's tag: HMAC-SHA256 (@noble/hashes, synchronous, so parsing and paginating stay sync)
 * over the payload's exact bytes, keyed by the app's cursor secret as UTF-8. Without it a client
 * could write any sort values into a cursor and learn, row by row, the value of a column it can
 * sort by but not select or filter.
 */
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"

import { CombError } from "../error.ts"
import { combErrorKeys } from "../types.ts"
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts"

/** The shortest secret a cursor is signed with, in UTF-8 bytes: SHA-256's output length */
const MIN_CURSOR_SECRET_BYTES = 32

/** HMAC-SHA256 of `data` under `key` */
const macOf = (key: Uint8Array, data: Uint8Array): Uint8Array => hmac(sha256, key, data)

/** The secret's UTF-8 bytes; a 500 when it is shorter than the minimum, which is a wiring mistake */
function keyOf(secret: string): Uint8Array {
	const key = new TextEncoder().encode(typeof secret === "string" ? secret : "")
	if (key.length >= MIN_CURSOR_SECRET_BYTES) return key
	throw new CombError({
		cause: `the cursor secret must be at least ${MIN_CURSOR_SECRET_BYTES} bytes of UTF-8; pass the app's CURSOR_SECRET`,
		errorKey: combErrorKeys.CURSOR_NOT_WIRED,
		status: "internal_server_error",
	})
}

/* what a caller that left out its options (JS, or a cast) holds: no secret, which keyOf refuses with a 500 */
const NO_CURSOR_SECRET: { readonly cursorSecret: string } = { cursorSecret: "" }

/** Throw the 500 keyOf throws when `secret` cannot sign a cursor */
function assertCursorSecret(secret: string): void {
	keyOf(secret)
}

/** The base64url tag of `payload` under `secret` */
function signPayload(payload: string, secret: string): string {
	return encodeBase64Url(macOf(keyOf(secret), new TextEncoder().encode(payload)))
}

/** Whether `tag` is `payload`'s under `secret`, compared in constant time over the whole tag */
function verifyTag(payload: string, tag: string, secret: string): boolean {
	const expected = macOf(keyOf(secret), new TextEncoder().encode(payload))
	const given = decodeBase64Url(tag)
	/* the length is public: every real tag has the same one */
	if (given === null || given.length !== expected.length) return false
	let difference = 0
	for (let i = 0; i < expected.length; i++) difference |= (expected[i] as number) ^ (given[i] as number)
	return difference === 0
}

export { assertCursorSecret, macOf, NO_CURSOR_SECRET, MIN_CURSOR_SECRET_BYTES, signPayload, verifyTag }
