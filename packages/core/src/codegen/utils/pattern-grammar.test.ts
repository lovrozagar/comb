import { RE2JS } from "re2js"
import { describe, expect, it } from "vitest"
import { PORTABLE_PATTERNS } from "../../../tests/support/portable-patterns.ts"
import { unportableOf } from "./pattern-grammar.ts"
import { patternLiteral } from "./pattern.ts"

/* AA4-1 of r24: a pattern holds only the grammar ECMAScript on every Node comb supports, Go's RE2 and
   Rust's regex compile alike, so a construct outside it is refused, not published as written */
const refusal = (pattern: string): string => {
	try {
		patternLiteral(pattern, "t.code")
	} catch (error) {
		return (error as Error).message
	}
	return "taken"
}

const GROUP = (opening: string) =>
	`${opening}, a group other than (, (?: and (?<name>, which Node 22, Go's RE2 or Rust's regex refuses or reads as another rule: write the rule with those`

const PRODUCT = (count: string, product: number) =>
	`${count}, a count whose product with the counts inside it, ${product}, is past 1000, which Go's RE2 does not compile: write nested counts whose product is at most 1000`

const SIZE =
	"counts and classes too large for Rust's regex, which compiles a pattern into at most 10 MiB, so a validator there refuses the whole document: repeat a large class with + or * and bound the length with max, or write smaller counts"

const NESTED =
	"groups, counts and alternatives nested past 250 levels, which Rust's regex refuses: write the rule with less nesting"

const REFUSED: ReadonlyArray<readonly [string, string]> = [
	["/^a{02}$/u", "{02}, a count with a leading zero, which Go's RE2 reads as the text {02}: write {2}"],
	["/^a{01,3}$/u", "{01,3}, a count with a leading zero, which Go's RE2 reads as the text {01,3}: write {1,3}"],
	["/^a{2,03}$/u", "{2,03}, a count with a leading zero, which Go's RE2 reads as the text {2,03}: write {2,3}"],
	["/^a{00,}$/u", "{00,}, a count with a leading zero, which Go's RE2 reads as the text {00,}: write {0,}"],
	["/^(?:a{2}){501}$/u", PRODUCT("{501}", 1002)],
	["/^(?:(?:a{10}){10}){11}$/u", PRODUCT("{11}", 1100)],
	["/^(?:a{2,}){600}$/u", PRODUCT("{600}", 1200)],
	["/^(?:a|b{3}){334}$/u", PRODUCT("{334}", 1002)],
	["/^(?i:a)$/u", GROUP("(?i:")],
	["/^(?-i:a)$/u", GROUP("(?-i:")],
	["/^(?m:^a)$/u", GROUP("(?m:")],
	[
		"/^(?<é>a)$/u",
		"(?<é>, a group name past ASCII letters, digits and _, which Go's RE2 refuses: name the group with those, a letter or _ first",
	],
	[
		"/^(?<a$>a)$/u",
		"(?<a$>, a group name past ASCII letters, digits and _, which Go's RE2 refuses: name the group with those, a letter or _ first",
	],
	[
		"/^(?<n>a)|(?<n>b)$/u",
		"(?<n> twice, a group name used again, which Node 22, Go's RE2 and Rust's regex refuse: give each group its own name",
	],
	[String.raw`/^\p{L}{150}\p{L}{150}$/u`, SIZE],
	[String.raw`/^[\p{L}\p{N}]{400}$/u`, SIZE],
	[`/^${"a{1000}".repeat(299)}a{999}$/u`, SIZE],
	[`/${"(?:".repeat(251)}a${")".repeat(251)}/u`, NESTED],
	/* Rust counts the sequence the anchors make a level, as it does each group and alternation */
	[`/^${"(?:".repeat(250)}a${")".repeat(250)}$/u`, NESTED],
	[`/^${"(?:b|".repeat(125)}a${")".repeat(125)}$/u`, NESTED],
	[
		"/^\uD800$/u",
		String.raw`a lone surrogate, U+D800, which a JSON document carries as \ud800, Go's reader as U+FFFD and Rust's not at all: write the character meant`,
	],
]

describe("patternLiteral: only the grammar every engine reads alike (AA4-1 of r24)", () => {
	it.each(REFUSED)("refuses %s, naming the construct", (pattern, held) => {
		expect(refusal(pattern)).toBe(`t.code: pattern ${pattern} holds ${held}`)
	})

	/* the size budget and nesting limit were measured on Rust regex 1.13.1, the version the probe compiles with */
	it("takes a pattern at each bound: Go's product of 1000, Rust regex 1.13.1's size budget and nesting of 250", () => {
		for (const pattern of [
			/* each anchor costs a unit, as each construct costs at least one */
			`/^${"a{1000}".repeat(299)}a{998}$/u`,
			`/${"(?:".repeat(250)}a${")".repeat(250)}/u`,
			`/^${"(?:b|".repeat(124)}a${")".repeat(124)}$/u`,
			"/^(?:a{2}){500}$/u",
			"/^(?:a{0}){1000}$/u",
		])
			expect(refusal(pattern)).toBe("taken")
	})

	it.each(PORTABLE_PATTERNS)("takes %s, which RE2's syntax compiles", (pattern) => {
		const literal = patternLiteral(pattern, "x")
		expect(() => RE2JS.compile(literal.slice(1, -2))).not.toThrow()
	})

	it("throws a fault past a refusal as itself: a source not compiled under u is comb's bug, not the pattern's", () => {
		expect(() => unportableOf("a{")).toThrow(TypeError)
	})
})
