/**
 * The plaintext a password column's hash is made from, after NIST SP 800-63B rev 4
 * §3.1.1.2: any storable text, normalized to NFC and then counted by code point, never trimmed,
 * with no composition rule. `passwordText()` sets a password, at least 15 characters (a password
 * used only with a second factor may take `min: 8`); `passwordText.typed()` reads one typed to
 * sign in, holding only the max, so a password set before a minimum still signs in. Under
 * `hash: "bcrypt"` both refuse past the 72 UTF-8 bytes bcrypt reads, and `set` refuses a `min` past
 * them. The column itself holds the hash, which codegen holds to its declared bounds alone.
 */
import * as z from "zod"
import { isStorableText, STORABLE_TEXT_RULE } from "./storable-text.ts"

/** The most UTF-8 bytes bcrypt reads of a password; it ignores the rest */
const BCRYPT_BYTES = 72

/** The scheme a password is hashed with, where it limits what the hash reads */
export type PasswordHash = "bcrypt"

/** What a typed password is held to: the most characters, and the scheme it is hashed with */
export type TypedPasswordOptions = {
	/** The scheme the password is hashed with; `bcrypt` also refuses a password past the 72 UTF-8 bytes bcrypt reads */
	hash?: PasswordHash | undefined
	/** The most characters, counted by code point after NFC normalization; a whole number from 1, 128 by default */
	max?: number | undefined
}

/** What a password set is held to: a typed one's, and the fewest characters */
export type PasswordTextOptions = TypedPasswordOptions & {
	/** The fewest characters, counted as `max` is; a whole number from 0 up to `max`, 15 by default, and at most 72 under `bcrypt` */
	min?: number | undefined
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length

/** Refuses a bound that is no whole number from `floor` */
function refuseBound(name: "max" | "min", bound: number, floor: number): void {
	if (!Number.isInteger(bound) || bound < floor)
		throw new TypeError(`passwordText's ${name} is a whole number from ${floor}, not ${bound}`)
}

/**
 * The schema of a password of `min` (0 for none) to `max` characters, under `hash`. zod counts a
 * length by code point and runs the NFC overwrite before its checks, so its own min and max bind the
 * NFC form, give the too_small and too_big issues every comb length gives, and publish themselves;
 * the rewrite is published as the `nfc` transform, and bcrypt's bytes as `x-comb-maxUtf8Bytes`, the
 * string's own bytes, never `x-comb-maxBytes`, which bounds a value's JSON text
 */
function password(min: number, max: number, hash: PasswordHash | undefined): z.ZodString {
	const bcrypt = hash === "bcrypt"
	const normalized = z.string().normalize("NFC")
	const schema = (min > 0 ? normalized.min(min) : normalized)
		.max(max)
		.refine(isStorableText, { message: "Must not contain U+0000 or an unpaired surrogate" })
	const bounded = bcrypt
		? schema.superRefine((value, ctx) => {
				if (utf8Bytes(value) > BCRYPT_BYTES)
					ctx.addIssue({
						code: "too_big",
						inclusive: true,
						input: value,
						maximum: BCRYPT_BYTES,
						message: `Must be at most ${BCRYPT_BYTES} bytes in UTF-8`,
						origin: "string",
					})
			})
		: schema
	return bounded.meta({
		"x-comb-text": STORABLE_TEXT_RULE,
		"x-comb-transform": ["nfc"],
		...(bcrypt ? { "x-comb-maxUtf8Bytes": BCRYPT_BYTES } : {}),
	})
}

/** A password typed to sign in: storable, NFC, at most `max` characters (128 by default), and bcrypt's bytes under it */
function typed({ hash, max = 128 }: TypedPasswordOptions = {}): z.ZodString {
	refuseBound("max", max, 1)
	return password(0, max, hash)
}

/** A password set: a typed one's rules and at least `min` characters (15 by default) */
function set({ hash, max = 128, min = 15 }: PasswordTextOptions = {}): z.ZodString {
	refuseBound("min", min, 0)
	refuseBound("max", max, 1)
	if (min > max) throw new TypeError(`passwordText's min ${min} is past its max ${max}`)
	/* every code point is a byte at least, so past bcrypt's bytes no password is one it reads */
	if (hash === "bcrypt" && min > BCRYPT_BYTES)
		throw new TypeError(`passwordText's min ${min} leaves no password bcrypt reads: bcrypt reads ${BCRYPT_BYTES} bytes`)
	return password(min, max, hash)
}

/** A password set, and `typed` for one typed to sign in */
export const passwordText: typeof set & {
	/** A password typed to sign in: storable, NFC, at most `max` characters (128 by default), and bcrypt's bytes under it; it holds no minimum, so a password set before one still signs in */
	typed: typeof typed
} = /* @__PURE__ */ Object.assign(set, { typed })
