/**
 * ULID + prefixed ID generation.
 * Zero dependencies — uses Web Crypto API (CF Workers, Node, Bun, Deno).
 *
 * Format: 26 chars Crockford's Base32
 *   - First 10: 48-bit timestamp (ms since epoch)
 *   - Last 16: 80-bit randomness
 *
 * `generateUlid` / `generateId` are ordered by millisecond only: two ids from the same
 * millisecond compare at random. `createUlidFactory` keeps its last id and issues strictly
 * increasing ones, through a clock that steps back too. The state lives in the factory you
 * hold, not in this module, so it is never shared across requests unless you share it.
 */

const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz"
const ENCODING_LEN = 32
const TIME_LEN = 10
const RANDOM_LEN = 16
const PREFIX_PATTERN = /^[a-z][a-z0-9]{1,9}$/

type UlidFactoryOptions = {
	/** The clock, ms since epoch; `Date.now` by default */
	now?: () => number
	/** Fills the bytes with randomness; `crypto.getRandomValues` by default */
	random?: (bytes: Uint8Array<ArrayBuffer>) => void
}

/** 10 base32 chars of a 48-bit timestamp */
function encodeTime(time: number): string {
	let out = ""
	let t = time
	for (let i = 0; i < TIME_LEN; i++) {
		out = ENCODING[t % ENCODING_LEN] + out
		t = Math.floor(t / ENCODING_LEN)
	}
	return out
}

/** 16 random base32 digits; `byte % 32` keeps 5 unbiased bits, as 256 is a multiple of 32 */
function randomDigits(random: (bytes: Uint8Array<ArrayBuffer>) => void): number[] {
	const bytes = new Uint8Array(RANDOM_LEN)
	random(bytes)
	return Array.from(bytes, (byte) => byte % ENCODING_LEN)
}

const encodeDigits = (digits: readonly number[]) => digits.map((digit) => ENCODING[digit]).join("")

/** `digits` plus one, as one base32 number; null when every digit is already the largest */
function increment(digits: readonly number[]): number[] | null {
	const next = [...digits]
	for (let i = next.length - 1; i >= 0; i--) {
		if ((next[i] as number) < ENCODING_LEN - 1) {
			next[i] = (next[i] as number) + 1
			return next
		}
		next[i] = 0
	}
	return null
}

const webRandom = (bytes: Uint8Array<ArrayBuffer>) => {
	crypto.getRandomValues(bytes)
}

function checkPrefix(prefix: string): void {
	if (!PREFIX_PATTERN.test(prefix)) {
		throw new Error(
			`Invalid entity prefix "${prefix}": must be 2-10 lowercase alphanumeric chars starting with a letter`,
		)
	}
}

/**
 * A ULID source whose ids strictly increase: within one millisecond the random part counts up
 * by one, a clock that steps back is held at the last time issued, and a random part that cannot
 * count up any further moves on to the next millisecond.
 */
function createUlidFactory(options: UlidFactoryOptions = {}): { id: (prefix: string) => string; ulid: () => string } {
	const now = options.now ?? Date.now
	const random = options.random ?? webRandom
	let lastTime = -1
	let lastDigits: number[] = []

	function ulid(): string {
		const time = Math.max(now(), lastTime)
		const counted = time === lastTime ? increment(lastDigits) : null
		lastTime = counted === null && time === lastTime ? time + 1 : time
		lastDigits = counted ?? randomDigits(random)
		return encodeTime(lastTime) + encodeDigits(lastDigits)
	}

	return {
		id: (prefix) => {
			checkPrefix(prefix)
			return `${prefix}_${ulid()}`
		},
		ulid,
	}
}

/** Generate a ULID (26-char, base32, ordered by millisecond) */
function generateUlid(): string {
	return encodeTime(Date.now()) + encodeDigits(randomDigits(webRandom))
}

/** Generate a prefixed ID: `{prefix}_{ulid}` */
function generateId(prefix: string): string {
	checkPrefix(prefix)
	return `${prefix}_${generateUlid()}`
}

export { createUlidFactory, generateId, generateUlid, type UlidFactoryOptions }
