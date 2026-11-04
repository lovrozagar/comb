import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import { patternLiteral as emitted } from "./pattern.ts"

/* A3-2 of r23: every pattern comb takes here compiles under RE2's syntax, as Go's validators read it */
function patternLiteral(pattern: string, place: string): string {
	const literal = emitted(pattern, place)
	expect(() => RE2JS.compile(literal.slice(1, -2)), literal).not.toThrow()
	return literal
}

describe("patternLiteral: a pattern comb can emit and publish (F5, F6)", () => {
	it("writes a pattern back as a literal that compiles under u, a slash and a line terminator escaped", () => {
		expect(patternLiteral("/^a+$/", "x")).toBe("/^a+$/u")
		expect(patternLiteral("/^a/b$/", "x")).toBe(String.raw`/^a\/b$/u`)
		expect(patternLiteral(String.raw`/^a\/b$/`, "x")).toBe(String.raw`/^a\/b$/u`)
		expect(patternLiteral("/^a\nb\r$/u", "x")).toBe(String.raw`/^a\nb\r$/u`)
		/* the engine's own source, which a regex in the tables file publishes as: a slash in a class stays */
		expect(patternLiteral("/^[A-Za-z_/]+$/", "x")).toBe("/^[A-Za-z_/]+$/u")
		expect(patternLiteral("/[^/]/b/", "x")).toBe(String.raw`/[^/]\/b/u`)
		for (const pattern of ["/^a+$/", "/^a/b$/", "/^a\nb$/", '/^[^"]+$/u'])
			expect(() => new Function(`return ${patternLiteral(pattern, "x")}`)()).not.toThrow()
	})

	it("refuses a value that is no /source/flags, naming the column", () => {
		for (const pattern of ["^[a-z]+$", "/", "//", "/a/B"])
			expect(() => patternLiteral(pattern, "t.name")).toThrow(
				/^t\.name: pattern .* is not a regex: write it as \/source\/flags$/,
			)
	})

	it("refuses every flag JSON Schema cannot publish, and takes u alone", () => {
		/* JSON Schema compiles a pattern under u, as Ajv does: a v source (set subtraction) does not compile there (F5) */
		for (const flag of ["i", "m", "s", "g", "y", "d", "v"])
			expect(() => patternLiteral(`/^a$/${flag}`, "t.code")).toThrow(
				/takes the flag .*, which JSON Schema cannot publish/,
			)
		expect(patternLiteral("/^a$/u", "x")).toBe("/^a$/u")
		expect(() => patternLiteral("/^[\\p{L}--[a-z]]+$/v", "t.name")).toThrow(
			"t.name: pattern /^[\\p{L}--[a-z]]+$/v takes the flag v, which JSON Schema cannot publish",
		)
	})

	it("refuses a source the engine cannot compile, with the engine's message", () => {
		expect(() => patternLiteral('/^[^\\"]+$/u', "t.q")).toThrow(
			/^t\.q: pattern .* does not compile under u, the mode JSON Schema reads a pattern in: Invalid regular expression/,
		)
		expect(() => patternLiteral("/(/", "t.q")).toThrow(/does not compile/)
	})

	/* CS1 of r22b: a source read without u is another rule than the one JSON Schema publishes */
	it("reads a pattern written without u under u, so zod runs the rule a reader runs", () => {
		const literal = patternLiteral(String.raw`/^\p{L}[^\n\r]$/`, "t.name")
		expect(literal).toBe(String.raw`/^\p{L}[^\n\r]$/u`)
		const regex = new Function(`return ${literal}`)() as RegExp
		expect(["é😀", "ж𝒜"].map((text) => regex.test(text))).toEqual([true, true])
		expect(regex.test("p{L}x")).toBe(false)
	})

	it("refuses a source written without u that does not compile under it, naming the construct", () => {
		expect(() => patternLiteral(String.raw`/^a\-b$/`, "t.code")).toThrow(
			String.raw`t.code: pattern /^a\-b$/ does not compile under u, the mode JSON Schema reads a pattern in: Invalid regular expression: /^a\-b$/u: Invalid escape`,
		)
	})
})

describe("patternLiteral: a pattern with no shorthand class (AA7 of r22)", () => {
	/* AA7 of r22: Go's RE2 reads \s and \S as ASCII and Rust's regex reads \d and \w as Unicode, so
	   one of these publishes three rules; a class written out means the same in each engine */
	it.each([
		[String.raw`/^\d{5}$/`, String.raw`\d`, "[0-9]"],
		[String.raw`/^\D$/`, String.raw`\D`, "[^0-9]"],
		[String.raw`/^\w+$/u`, String.raw`\w`, "[A-Za-z0-9_]"],
		[String.raw`/^[\W]$/`, String.raw`\W`, "[^A-Za-z0-9_]"],
		[String.raw`/^a\sb$/`, String.raw`\s`, "the blanks it means, as [ \\t]"],
		[String.raw`/^\S+$/`, String.raw`\S`, "the blanks it refuses, as [^ \\t]"],
		[String.raw`/\bcat\b/`, String.raw`\b`, "the characters on either side as classes, such as (?:^|[^A-Za-z0-9_])"],
		[String.raw`/a\B/`, String.raw`\B`, "the characters on either side as classes, such as (?:^|[^A-Za-z0-9_])"],
	])("refuses %s, naming the class to write for %s", (pattern, escape, instead) => {
		expect(() => patternLiteral(pattern, "t.code")).toThrow(
			`t.code: pattern ${pattern} holds ${escape}, which ECMAScript, Go's RE2 and Rust's regex read as other sets: write ${instead}`,
		)
	})

	it("takes an escaped backslash before a letter, and a letter escape outside the shorthand set", () => {
		expect(patternLiteral(String.raw`/^\\d$/`, "x")).toBe(String.raw`/^\\d$/u`)
		expect(patternLiteral(String.raw`/^[0-9]\.\p{L}\n$/`, "x")).toBe(String.raw`/^[0-9]\.\p{L}\n$/u`)
	})
})

describe("patternLiteral: a pattern each engine reads as one rule (A2-7 of r22)", () => {
	const UNREAD =
		"which Go's RE2 and Rust's regex do not compile, so a validator in either refuses the whole document: write the rule without it"

	it.each([String.raw`/^.{2}$/`, String.raw`/^a\\.$/u`, String.raw`/^[a-]+.$/`])(
		"refuses %s, as ECMAScript's . refuses \\r, U+2028 and U+2029 and RE2's and Rust's take them",
		(pattern) => {
			expect(() => patternLiteral(pattern, "t.code")).toThrow(
				String.raw`t.code: pattern ${pattern} holds ., which ECMAScript reads as any character but a line terminator and Go's RE2 and Rust's regex as any but \n: write [^\n\r], or the class meant`,
			)
		},
	)

	it.each([
		[String.raw`/^(?=a)a$/`, "(?=", "a lookaround"],
		[String.raw`/^(?!b)a$/`, "(?!", "a lookaround"],
		[String.raw`/^a(?<=a)$/`, "(?<=", "a lookaround"],
		[String.raw`/^a(?<!b)$/`, "(?<!", "a lookaround"],
		[String.raw`/^(a)\1$/`, String.raw`\1`, "a backreference"],
		[String.raw`/^(?<n>a)\k<n>$/u`, String.raw`\k`, "a backreference"],
	])("refuses %s, naming %s, %s", (pattern, construct, kind) => {
		expect(() => patternLiteral(pattern, "t.code")).toThrow(
			`t.code: pattern ${pattern} holds ${construct}, ${kind}, ${UNREAD}`,
		)
	})

	it.each([String.raw`/^a\0$/`, String.raw`/^[\0-\x1f]$/u`])(
		"refuses %s, as Rust's regex refuses an octal escape",
		(pattern) => {
			expect(() => patternLiteral(pattern, "t.code")).toThrow(
				String.raw`t.code: pattern ${pattern} holds \0, which Rust's regex refuses as an octal escape, so a validator there refuses the whole document: write \x00, which ECMAScript, Go's RE2 and Rust's regex read as NUL`,
			)
		},
	)

	it("takes an escaped dot, a dot in a class, a named group and a group that only starts with (?", () => {
		expect(patternLiteral(String.raw`/^a\.b$/`, "x")).toBe(String.raw`/^a\.b$/u`)
		expect(patternLiteral(String.raw`/^[.\]]+$/u`, "x")).toBe(String.raw`/^[.\]]+$/u`)
		expect(patternLiteral(String.raw`/^(?<year>[0-9]{4})(?:-[0-9]{2})?$/`, "x")).toBe(
			String.raw`/^(?<year>[0-9]{4})(?:-[0-9]{2})?$/u`,
		)
		expect(patternLiteral(String.raw`/^[^\n\r]{2}\x00$/`, "x")).toBe(String.raw`/^[^\n\r]{2}\x00$/u`)
	})
})

/* A3-2 of r23: each construct an engine comb names reads otherwise, and what the refusal names */
const PROPERTY =
	"which Go's RE2 or Rust's regex does not compile, or reads as another set: write a General_Category value as Go's RE2 names it, such as \\p{L}, \\p{Lu} or \\p{Nd}, or the ranges meant"

const REFUSED: ReadonlyArray<readonly [string, string]> = [
	[String.raw`/^\u0041$/u`, String.raw`\u0041, which Go's RE2 does not compile: write \x41`],
	[String.raw`/^\u00e9\u{1F600}$/u`, String.raw`\u00e9, which Go's RE2 does not compile: write \xE9`],
	[
		String.raw`/^\u{1F600}$/u`,
		String.raw`\u{1F600}, which Go's RE2 does not compile: write the character itself, U+1F600`,
	],
	[
		String.raw`/^\uD83D\uDE00$/u`,
		String.raw`\uD83D\uDE00, which Go's RE2 does not compile: write the character itself, U+1F600`,
	],
	/* the engine's own source, which comb publishes, writes a line terminator as its \u escape */
	[
		"/^a\u2028$/u",
		String.raw`\u2028, a line terminator a regex literal holds only as an escape, which Go's RE2 does not compile: write \p{Zl}`,
	],
	[
		"/^[\u2029]$/u",
		String.raw`\u2029, a line terminator a regex literal holds only as an escape, which Go's RE2 does not compile: write \p{Zp}`,
	],
	[String.raw`/^\p{Script=Greek}$/u`, String.raw`\p{Script=Greek}, ${PROPERTY}`],
	[String.raw`/^\p{sc=Greek}$/u`, String.raw`\p{sc=Greek}, ${PROPERTY}`],
	[String.raw`/^\P{General_Category=Lu}$/u`, String.raw`\P{General_Category=Lu}, ${PROPERTY}`],
	[String.raw`/^\p{Emoji}$/u`, String.raw`\p{Emoji}, ${PROPERTY}`],
	[String.raw`/^[\p{ASCII}]$/u`, String.raw`\p{ASCII}, ${PROPERTY}`],
	[String.raw`/^\p{Letter}$/u`, String.raw`\p{Letter}, ${PROPERTY}`],
	[String.raw`/^\p{Cs}$/u`, String.raw`\p{Cs}, ${PROPERTY}`],
	[String.raw`/^\cJ$/u`, String.raw`\cJ, a control escape, which Go's RE2 and Rust's regex do not compile: write \x0A`],
	[
		String.raw`/^[]$/u`,
		"[], a class of no character, which Go's RE2 and Rust's regex do not compile: write the rule without it",
	],
	[
		String.raw`/^a[^]$/u`,
		String.raw`[^], a class of every character, which Go's RE2 and Rust's regex do not compile: write [\p{L}\P{L}]`,
	],
	[
		String.raw`/^[a&&b]$/u`,
		String.raw`&& in a class, which Rust's regex reads as a set operation: write & once, or as \x26`,
	],
	[
		String.raw`/^[+--]$/u`,
		String.raw`-- in a class, which Rust's regex reads as a set operation: write - once, or as \x2D`,
	],
	[
		String.raw`/^[a~~b]$/u`,
		String.raw`~~ in a class, which Rust's regex reads as a set operation: write ~ once, or as \x7E`,
	],
	[String.raw`/^[a[]$/u`, String.raw`[ in a class, which Rust's regex reads as a nested class: write \[`],
	[
		String.raw`/^a{1001}$/u`,
		"{1001}, a count past 1000, which Go's RE2 does not compile: write the rule with a count of at most 1000",
	],
	[
		String.raw`/^a{2,1001}$/u`,
		"{2,1001}, a count past 1000, which Go's RE2 does not compile: write the rule with a count of at most 1000",
	],
]

describe("patternLiteral: only the escapes and classes every engine reads alike (A3-2 of r23)", () => {
	it.each(REFUSED)("refuses %s, naming the portable spelling", (pattern, held) => {
		expect(() => emitted(pattern, "t.code")).toThrow(`t.code: pattern ${pattern} holds ${held}`)
	})

	it("takes a General_Category, \\xHH, \\t \\n \\r \\f \\v and an escaped syntax character", () => {
		for (const pattern of [
			String.raw`/^\p{Lu}+$/u`,
			String.raw`/^\x41$/u`,
			String.raw`/^\P{Nd}\p{LC}[\p{L}\P{L}]\p{Zl}\p{Zp}$/u`,
			String.raw`/^[\t\n\r\f\v]\t\n\r\f\v$/u`,
			String.raw`/^\^\$\\\.\*\+\?\(\)\[\]\{\}\|\/$/u`,
			String.raw`/^[\-\[\]&~]a{1000}b{2,1000}c{3,}$/u`,
		])
			expect(patternLiteral(pattern, "x")).toBe(pattern)
	})
})
