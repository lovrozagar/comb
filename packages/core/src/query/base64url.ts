/**
 * base64url (RFC 4648 §5) without padding, as a cursor's payload and tag are written: bytes in,
 * text out, and back. Strict on the way in: text with any other character, or a length no bytes
 * encode to, is null.
 */

/** `bytes` as unpadded base64url */
function encodeBase64Url(bytes: Uint8Array): string {
	let binary = ""
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The bytes unpadded base64url `text` holds, or null when it is not that */
function decodeBase64Url(text: string): Uint8Array | null {
	/* a length of 1 mod 4 encodes no whole byte */
	if (!/^[\w-]*$/.test(text) || text.length % 4 === 1) return null
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/")
	const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="))
	return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export { decodeBase64Url, encodeBase64Url }
