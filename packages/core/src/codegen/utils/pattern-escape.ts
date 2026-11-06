/* The escapes a pattern may hold: what each engine comb names reads otherwise in one, and its spelling there */

const BOUNDARY = "the characters on either side as classes, such as (?:^|[^A-Za-z0-9_])"

// lookup-table: the class a shorthand escape stands for, written out
const WRITTEN_OUT: Readonly<Record<string, string>> = {
	B: BOUNDARY,
	D: "[^0-9]",
	S: "the blanks it refuses, as [^ \\t]",
	W: "[^A-Za-z0-9_]",
	b: BOUNDARY,
	d: "[0-9]",
	s: "the blanks it means, as [ \\t]",
	w: "[A-Za-z0-9_]",
}

/* lookaround and backreferences, past RE2's syntax, which Go's and Rust's validators compile */
export const UNREAD =
	"which Go's RE2 and Rust's regex do not compile, so a validator in either refuses the whole document: write the rule without it"

/* ECMAScript's. refuses \n, \r, U+2028 and U+2029; RE2's and Rust's refuse \n alone */
export const DOT =
	"., which ECMAScript reads as any character but a line terminator and Go's RE2 and Rust's regex as any but \\n: write [^\\n\\r], or the class meant"

/* NUL as every engine comb names spells it */
const OCTAL =
	"which Rust's regex refuses as an octal escape, so a validator there refuses the whole document: write \\x00, which ECMAScript, Go's RE2 and Rust's regex read as NUL"

/* a group's opening that looks around, which a named group's (?<name> is not */
export const LOOKAROUND: RegExp = /^\(\?<?[!=]/

/* the escapes past a letter or \0 every engine reads as ECMAScript does: syntax characters, - in a class, and \t \n \r \f \v */
const SAME_ESCAPES = "^$\\.*+?()[]{}|/tnrfv"

/* the General_Category values Go's RE2 names, which Rust's regex reads alike: Cs, a surrogate, Rust refuses */
// lookup-table: a \p{…} every engine compiles
const CATEGORIES: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"C",
	"Cc",
	"Cf",
	"Cn",
	"Co",
	"L",
	"LC",
	"Ll",
	"Lm",
	"Lo",
	"Lt",
	"Lu",
	"M",
	"Mc",
	"Me",
	"Mn",
	"N",
	"Nd",
	"Nl",
	"No",
	"P",
	"Pc",
	"Pd",
	"Pe",
	"Pf",
	"Pi",
	"Po",
	"Ps",
	"S",
	"Sc",
	"Sk",
	"Sm",
	"So",
	"Z",
	"Zl",
	"Zp",
	"Zs",
])

const PROPERTY =
	"which Go's RE2 or Rust's regex does not compile, or reads as another set: write a General_Category value as Go's RE2 names it, such as \\p{L}, \\p{Lu} or \\p{Nd}, or the ranges meant"

const NO_U = "which Go's RE2 does not compile"

/** `code` as \xHH, its two hex digits capitals */
export const hexOf = (code: number): string => `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`

/** The \u escape at `at`, its code point read as u reads it (a surrogate pair as one), and its last index */
function unicodeEscapeAt(source: string, at: number): { end: number; refused: string } {
	const braced = /^\\u\{([0-9A-Fa-f]+)\}/.exec(source.slice(at))
	const pair = /^\\u(D[89AB][0-9A-F]{2})\\u(D[C-F][0-9A-F]{2})/i.exec(source.slice(at))
	const [text, code] = braced
		? [braced[0], Number.parseInt(braced[1] as string, 16)]
		: pair
			? [
					pair[0],
					String.fromCharCode(...pair.slice(1).map((unit) => Number.parseInt(unit, 16))).codePointAt(0) as number,
				]
			: [source.slice(at, at + 6), Number.parseInt(source.slice(at + 2, at + 6), 16)]
	/* U+2028 and U+2029 alone are their General_Category, which every engine compiles */
	const instead =
		code === 0x2028 || code === 0x2029
			? `, a line terminator a regex literal holds only as an escape, ${NO_U}: write \\p{${code === 0x2028 ? "Zl" : "Zp"}}`
			: `, ${NO_U}: write ${code <= 0xff ? hexOf(code) : `the character itself, U+${code.toString(16).toUpperCase()}`}`
	return { end: at + text.length - 1, refused: `${text}${instead}` }
}

/** The escape whose backslash is at `at`: what an engine comb names reads otherwise in it, or null, and its last index */
export function escapeAt(source: string, at: number): { end: number; refused: string | null } {
	const escaped = source[at + 1] as string
	const one = (refused: string | null) => ({ end: at + 1, refused })
	if (Object.hasOwn(WRITTEN_OUT, escaped))
		return one(
			`\\${escaped}, which ECMAScript, Go's RE2 and Rust's regex read as other sets: write ${WRITTEN_OUT[escaped]}`,
		)
	/* Rust's regex refuses an octal escape, \0 among them, in a class or out */
	if (escaped === "0") return one(`\\0, ${OCTAL}`)
	/* under u a class holds no backreference, a source that compiled none there */
	if (/[1-9k]/.test(escaped)) return one(`\\${escaped}, a backreference, ${UNREAD}`)
	if (SAME_ESCAPES.includes(escaped) || escaped === "-") return one(null)
	/* under u, \x has its two hex digits and \p its {name} */
	if (escaped === "x") return { end: at + 3, refused: null }
	if (escaped === "p" || escaped === "P") {
		const end = source.indexOf("}", at)
		const name = source.slice(at + 3, end)
		return { end, refused: CATEGORIES.has(name) ? null : `\\${escaped}{${name}}, ${PROPERTY}` }
	}
	if (escaped === "u") return unicodeEscapeAt(source, at)
	/* the one escape u has left, \c and its letter */
	const letter = source[at + 2] as string
	return {
		end: at + 2,
		refused: `\\c${letter}, a control escape, which Go's RE2 and Rust's regex do not compile: write ${hexOf(letter.charCodeAt(0) % 32)}`,
	}
}

/** A construct a pattern holds that an engine comb names reads otherwise, or not at all, named as the error states it */
export class Unportable extends Error {}

/** Ends the scan, refusing the pattern for `held` */
export function refuse(held: string): never {
	throw new Unportable(held)
}
