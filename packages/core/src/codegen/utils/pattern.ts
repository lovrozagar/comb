/**
 * A constraint's `pattern`, checked at codegen and written back as a regex literal comb built.
 * The value is spliced into the generated DTOs, so one comb cannot emit (no slashes, a newline, a
 * slash unescaped, a template string) failed tsc, or compiled and threw when the module loaded.
 * JSON Schema's `pattern` has no flags, so `i`, `m` and `s`, which change what matches, would
 * publish another rule than the server applies; `g` and `y` mean nothing to one test. JSON
 * Schema compiles a pattern under `u`, as Ajv does, where a `v` source (set subtraction) does not
 * compile. And a source read without `u` means another rule: `\p{L}` is a
 * literal `p{L}`, `.` and `[^x]` match a UTF-16 unit, not a code point. So a pattern
 * is `/source/flags` with `u` at most, compiled and emitted under `u` whether it was written or not.
 * And ECMAScript, Go's RE2 and Rust's regex read \d, \w, \s and \b, and their capitals, as other
 * sets (RE2's \s is ASCII, Rust's \d and \w Unicode), so a pattern writes each class out,
 * a `.` too, and holds no lookaround or backreference, which neither compiles, nor a `\0`, which Rust's
 * regex refuses. It holds only the escapes and classes every engine reads alike, as Go
 * and Rust compile the source comb publishes, in the grammar all three read as one rule:
 * pattern-grammar.ts holds it.
 */

import { unportableOf } from "./pattern-grammar.ts"

/* a lone surrogate, which the engine's source holds as written; a pair is one scalar value */
function loneSurrogateOf(source: string): string | null {
	const lone = /\p{Cs}/u.exec(source)
	if (lone === null) return null
	const code = `U+${(lone[0].codePointAt(0) as number).toString(16).toUpperCase()}`
	return `a lone surrogate, ${code}, which a JSON document carries as \\u${code.slice(2).toLowerCase()}, Go's reader as U+FFFD and Rust's not at all: write the character meant`
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
	const unportable = loneSurrogateOf(compiled.source) ?? unportableOf(compiled.source)
	if (unportable !== null) throw new Error(`${place}: pattern ${pattern} holds ${unportable}`)
	/* the engine's own source, the text a regex literal holds: a slash escaped outside a class only, a
	 * line terminator as its escape, so the pattern publishes as the regex in the tables file would */
	return `/${compiled.source}/u`
}

/**
 * The expression that builds the regex of `literal`, one patternLiteral made. Bun's transpiler
 * writes each non-ASCII character of a regex literal as a \u escape, a surrogate pair past U+FFFF,
 * and zod publishes the regex's source, where Go's RE2 reads no \u and Rust's regex no surrogate:
 * a source holding one is handed to RegExp as a string, whose value a transpiler keeps
 */
function regexExpression(literal: string): string {
	if ([...literal].every((char) => (char.codePointAt(0) as number) < 0x80)) return literal
	return `new RegExp(${JSON.stringify(literal.slice(1, literal.lastIndexOf("/")))}, "u")`
}

export { patternLiteral, regexExpression }
