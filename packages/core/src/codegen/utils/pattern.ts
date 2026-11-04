/**
 * A constraint's `pattern`, checked at codegen and written back as a regex literal comb built.
 * The value is spliced into the generated DTOs, so one comb cannot emit (no slashes, a newline, a
 * slash unescaped, a template string) failed tsc, or compiled and threw when the module loaded
 * (F5). JSON Schema's `pattern` has no flags, so `i`, `m` and `s`, which change what matches, would
 * publish another rule than the server applies; `g` and `y` mean nothing to one test (F6). JSON
 * Schema compiles a pattern under `u`, as Ajv does, where a `v` source (set subtraction) does not
 * compile (the 0.12 review's F5). And a source read without `u` means another rule: `\p{L}` is a
 * literal `p{L}`, `.` and `[^x]` match a UTF-16 unit, not a code point (CS1 of r22b). So a pattern
 * is `/source/flags` with `u` at most, compiled and emitted under `u` whether it was written or not.
 * And ECMAScript, Go's RE2 and Rust's regex read \d, \w, \s and \b, and their capitals, as other
 * sets (RE2's \s is ASCII, Rust's \d and \w Unicode), so a pattern writes each class out (AA7 of r22),
 * a `.` too, and holds no lookaround or backreference, which neither compiles, nor a `\0`, which Rust's
 * regex refuses (A2-7 of r22). It holds only the escapes and classes every engine reads alike, as Go
 * and Rust compile the source comb publishes (A3-2 of r23).
 */

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
const UNREAD =
	"which Go's RE2 and Rust's regex do not compile, so a validator in either refuses the whole document: write the rule without it"

/* ECMAScript's . refuses \n, \r, U+2028 and U+2029; RE2's and Rust's refuse \n alone (A2-7 of r22) */
const DOT =
	"., which ECMAScript reads as any character but a line terminator and Go's RE2 and Rust's regex as any but \\n: write [^\\n\\r], or the class meant"

/* NUL as every engine comb names spells it */
const OCTAL =
	"which Rust's regex refuses as an octal escape, so a validator there refuses the whole document: write \\x00, which ECMAScript, Go's RE2 and Rust's regex read as NUL"

/* a group's opening that looks around, which a named group's (?<name> is not */
const LOOKAROUND = /^\(\?<?[!=]/

/* the escapes past a letter or \0 every engine reads as ECMAScript does: syntax characters, - in a class, and \t \n \r \f \v */
const SAME_ESCAPES = "^$\\.*+?()[]{}|/tnrfv"

/* the General_Category values Go's RE2 names, which Rust's regex reads alike: Cs, a surrogate, Rust refuses (A3-2 of r23) */
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
const hexOf = (code: number): string => `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`

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
function escapeAt(source: string, at: number): { end: number; refused: string | null } {
	const escaped = source[at + 1] as string
	const one = (refused: string | null) => ({ end: at + 1, refused })
	if (Object.hasOwn(WRITTEN_OUT, escaped))
		return one(
			`\\${escaped}, which ECMAScript, Go's RE2 and Rust's regex read as other sets: write ${WRITTEN_OUT[escaped]}`,
		)
	/* Rust's regex refuses an octal escape, \0 among them, in a class or out (A2-7 of r22) */
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

/** What the class opening at `at` holds that Go's RE2 or Rust's regex reads otherwise, or null */
function classAt(source: string, at: number): string | null {
	if (source.startsWith("[]", at))
		return "[], a class of no character, which Go's RE2 and Rust's regex do not compile: write the rule without it"
	if (source.startsWith("[^]", at))
		return "[^], a class of every character, which Go's RE2 and Rust's regex do not compile: write [\\p{L}\\P{L}]"
	return null
}

/** What an unescaped character at `at` inside a class holds that Rust's regex reads otherwise, or null */
function inClassAt(source: string, at: number): string | null {
	const char = source[at] as string
	if (char === "[") return "[ in a class, which Rust's regex reads as a nested class: write \\["
	/* Rust reads && as an intersection, -- a difference and ~~ a symmetric difference */
	if ("&-~".includes(char) && source[at + 1] === char)
		return `${char}${char} in a class, which Rust's regex reads as a set operation: write ${char} once, or as ${hexOf(char.charCodeAt(0))}`
	return null
}

/** What the unescaped character at `at`, outside a class, holds that an engine comb names reads otherwise, or null */
function outsideAt(source: string, at: number): string | null {
	const char = source[at] as string
	if (char === ".") return DOT
	const look = LOOKAROUND.exec(source.slice(at))
	if (look !== null) return `${look[0]}, a lookaround, ${UNREAD}`
	/* under u a { is a count; Go's RE2 compiles one of at most 1000 */
	const count = /^\{([0-9]+)(?:,([0-9]*))?\}/.exec(source.slice(at))
	if (count !== null && Math.max(Number(count[1]), Number(count[2] ?? 0)) > 1000)
		return `${count[0]}, a count past 1000, which Go's RE2 does not compile: write the rule with a count of at most 1000`
	return null
}

/**
 * What `source`, the engine's own as comb publishes it, holds that an engine comb names reads
 * otherwise, or not at all, as the error states it; null for none. An allowlist (A3-2 of r23): an
 * escape is a syntax character, \xHH, \t \n \r \f \v or a General_Category, and a class holds no
 * construct Rust's regex reads as a set operation or a nested class
 */
function unportableOf(source: string): string | null {
	let inClass = false
	for (let at = 0; at < source.length; at++) {
		const char = source[at] as string
		let refused: string | null
		if (char === "\\") {
			const escape = escapeAt(source, at)
			refused = escape.refused
			at = escape.end
		} else if (inClass) {
			refused = inClassAt(source, at)
			inClass = char !== "]"
		} else if (char === "[") {
			refused = classAt(source, at)
			inClass = true
			/* a class's leading ^ is its negation, never a character in it */
			if (source[at + 1] === "^") at++
		} else refused = outsideAt(source, at)
		if (refused !== null) return refused
	}
	return null
}

/** The regex literal comb emits for `pattern`, the constraint at `place`; an error naming why it cannot */
function patternLiteral(pattern: string, place: string): string {
	const parts = /^\/([\s\S]+)\/([a-z]*)$/.exec(pattern)
	if (parts === null)
		throw new Error(`${place}: pattern ${JSON.stringify(pattern)} is not a regex: write it as /source/flags`)
	const [, source, flags] = parts as unknown as [string, string, string]
	const refused = [...flags].filter((flag) => flag !== "u")
	if (refused.length > 0) {
		throw new Error(
			`${place}: pattern ${pattern} takes the flag ${refused.join("")}, which JSON Schema cannot publish; write the rule into the source (a case-insensitive letter as [A-Za-z]), with u at most`,
		)
	}
	let compiled: RegExp
	try {
		compiled = new RegExp(source, "u")
	} catch (error) {
		throw new Error(
			`${place}: pattern ${pattern} does not compile under u, the mode JSON Schema reads a pattern in: ${(error as Error).message}`,
			{ cause: error },
		)
	}
	const unportable = unportableOf(compiled.source)
	if (unportable !== null) throw new Error(`${place}: pattern ${pattern} holds ${unportable}`)
	/* the engine's own source, the text a regex literal holds: a slash escaped outside a class only, a
	 * line terminator as its escape, so the pattern publishes as the regex in the tables file would */
	return `/${compiled.source}/u`
}

export { patternLiteral }
