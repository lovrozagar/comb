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
 * regex refuses (A2-7 of r22).
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

/** What `source` holds that an engine comb names reads otherwise, or not at all, as the error states it; null for none */
function unportableOf(source: string): string | null {
	let inClass = false
	for (let at = 0; at < source.length; at++) {
		const char = source[at] as string
		if (char === "\\") {
			at++
			const escaped = source[at] as string
			if (Object.hasOwn(WRITTEN_OUT, escaped))
				return `\\${escaped}, which ECMAScript, Go's RE2 and Rust's regex read as other sets: write ${WRITTEN_OUT[escaped]}`
			/* Rust's regex refuses an octal escape, \0 among them, in a class or out (A2-7 of r22) */
			if (escaped === "0") return `\\0, ${OCTAL}`
			/* under u a class holds no backreference, a source that compiled none there */
			if (/[1-9k]/.test(escaped)) return `\\${escaped}, a backreference, ${UNREAD}`
		} else if (inClass) inClass = char !== "]"
		else if (char === "[") inClass = true
		else if (char === ".") return DOT
		else {
			const look = LOOKAROUND.exec(source.slice(at))
			if (look !== null) return `${look[0]}, a lookaround, ${UNREAD}`
		}
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
	const unportable = unportableOf(source)
	if (unportable !== null) throw new Error(`${place}: pattern ${pattern} holds ${unportable}`)
	/* the engine's own source, the text a regex literal holds: a slash escaped outside a class only, a
	 * line terminator as its escape, so the pattern publishes as the regex in the tables file would */
	return `/${compiled.source}/u`
}

export { patternLiteral }
