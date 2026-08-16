/**
 * ULID + prefixed ID generation.
 * Zero dependencies — uses Web Crypto API (CF Workers, Node, Bun, Deno).
 *
 * Format: 26 chars Crockford's Base32
 *   - First 10: 48-bit timestamp (ms since epoch)
 *   - Last 16: 80-bit randomness
 * Lexicographically sortable by creation time.
 */

const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz"
const ENCODING_LEN = 32
const TIME_LEN = 10
const RANDOM_LEN = 16

/** Generate a ULID (26-char, base32, time-sortable) */
function generateUlid(): string {
	const time = Date.now()
	let timeStr = ""

	/* encode 48-bit timestamp into 10 base32 chars */
	let t = time
	for (let i = TIME_LEN - 1; i >= 0; i--) {
		const mod = t % ENCODING_LEN
		timeStr = ENCODING[mod] + timeStr
		t = Math.floor(t / ENCODING_LEN)
	}

	/* generate 80-bit random (16 chars) */
	const randomBytes = new Uint8Array(RANDOM_LEN)
	crypto.getRandomValues(randomBytes)
	let randomStr = ""
	for (let i = 0; i < RANDOM_LEN; i++) {
		const byte = randomBytes[i]
		if (byte === undefined) continue
		randomStr += ENCODING[byte % ENCODING_LEN]
	}

	return timeStr + randomStr
}

const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,9}$/

/** Generate a prefixed ID: `{prefix}_{ulid}` */
function generateId(prefix: string): string {
	if (!PREFIX_PATTERN.test(prefix)) {
		throw new Error(
			`Invalid entity prefix "${prefix}": must be 2-10 lowercase alphanumeric chars starting with a letter`,
		)
	}
	return `${prefix}_${generateUlid()}`
}

export { generateId, generateUlid }
