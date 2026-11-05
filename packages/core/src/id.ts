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
/** The last millisecond a ULID's 48-bit time holds */
const MAX_TIME = 2 ** 48 - 1

/** The clock and the randomness a ULID factory reads, each replaceable for tests or a runtime without them */
type UlidFactoryOptions = {
	/** The clock, ms since epoch, a fraction read at its millisecond; `Date.now` by default */
	now?: (() => number) | undefined
	/** Fills the bytes with randomness; `crypto.getRandomValues` by default */
	random?: ((bytes: Uint8Array<ArrayBuffer>) => void) | undefined
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

/* a millisecond a ULID's time cannot hold is refused, rather than encode "undefined" or wrap (QE7 of r22b) */
function held(ms: number): number {
	if (!(ms >= 0 && ms < MAX_TIME + 1)) {
		throw new RangeError(`createUlidFactory: the clock must read a millisecond from 0 to 2^48 - 1, got ${ms}`)
	}
	return ms
}

/** The clock's millisecond: a high-resolution reading such as `performance.timeOrigin + performance.now()` is floored */
const readClock = (now: () => number): number => Math.floor(held(now()))

const webRandom = (bytes: Uint8Array<ArrayBuffer>) => {
	crypto.getRandomValues(bytes)
}

/** Throw for a prefix generateId refuses: c.id checks it too, so a tables module fails where the app would (F55) */
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
 * count up any further moves on to the next millisecond. A clock reading outside ULID's milliseconds,
 * 0 to 2^48 - 1, throws a RangeError, as does a move past the last of them.
 */
function createUlidFactory(options: UlidFactoryOptions = {}): {
	/**
	 * A prefixed id, `{prefix}_{ulid}`, from this factory's ULIDs; throws for a prefix that is not 2 to
	 * 10 lowercase letters and digits starting with a letter
	 */
	id: (prefix: string) => string
	/** The next ULID, 26 base32 characters, greater than every one this factory issued; throws `RangeError` for a clock reading outside a ULID's time */
	ulid: () => string
} {
	const now = options.now ?? Date.now
	const random = options.random ?? webRandom
	let lastTime = -1
	let lastDigits: number[] = []

	function ulid(): string {
		const time = Math.max(readClock(now), lastTime)
		const counted = time === lastTime ? increment(lastDigits) : null
		/* B2-11 of area B: moving on from ULID's last millisecond is refused as a clock reading past it is */
		lastTime = counted === null && time === lastTime ? held(time + 1) : time
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

export { checkPrefix, createUlidFactory, generateId, generateUlid, type UlidFactoryOptions }
