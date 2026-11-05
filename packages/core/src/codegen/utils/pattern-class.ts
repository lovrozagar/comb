/* A pattern's classes and escapes, read into the sets of scalar values they match */

import { escapeAt, hexOf, refuse } from "./pattern-escape.ts"
import { type CodeSet, categoryRanges, complement, union } from "./pattern-unicode.ts"

// lookup-table: the code a control escape stands for
const CONTROLS: Readonly<Record<string, number>> = { f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b }

/** An escape or a class, read: its set, whether it is a class, its items in Rust's reading, and its last index */
export type Read = { class: boolean; end: number; items: number; set: CodeSet }

/** The escape whose backslash is at `at`, which escapeAt took: the set it matches and its last index */
export function escapeSet(source: string, at: number): Read {
	const { end, refused } = escapeAt(source, at)
	if (refused !== null) refuse(refused)
	const escaped = source[at + 1] as string
	if (escaped === "p" || escaped === "P") {
		const set = categoryRanges(source.slice(at + 3, end))
		return { class: true, end, items: 1, set: escaped === "P" ? complement(set) : set }
	}
	const code =
		escaped === "x"
			? Number.parseInt(source.slice(at + 2, at + 4), 16)
			: (CONTROLS[escaped] ?? (escaped.codePointAt(0) as number))
	return { class: false, end, items: 1, set: [[code, code]] }
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

/* the class member at `at`, an escape or one character */
function memberAt(source: string, at: number): Read {
	if (source[at] === "\\") return escapeSet(source, at)
	const held = inClassAt(source, at)
	if (held !== null) refuse(held)
	const code = source.codePointAt(at) as number
	return { class: false, end: at + (code > 0xffff ? 1 : 0), items: 1, set: [[code, code]] }
}

/** The class opening at `at`: the set it matches, its members, and the index of its ] */
export function bracket(source: string, at: number): Read {
	if (source.startsWith("[]", at))
		refuse("[], a class of no character, which Go's RE2 and Rust's regex do not compile: write the rule without it")
	if (source.startsWith("[^]", at))
		refuse("[^], a class of every character, which Go's RE2 and Rust's regex do not compile: write [\\p{L}\\P{L}]")
	const negated = source[at + 1] === "^"
	const ranges: Array<readonly [number, number]> = []
	let items = 0
	let next = at + (negated ? 2 : 1)
	while (source[next] !== "]") {
		const member = memberAt(source, next)
		next = member.end + 1
		/* under u a range runs between two single characters, and a - before ] is the character */
		if (!member.class && source[next] === "-" && source[next + 1] !== "]") {
			const held = inClassAt(source, next)
			if (held !== null) refuse(held)
			const to = memberAt(source, next + 1)
			ranges.push([(member.set[0] as readonly [number, number])[0], (to.set[0] as readonly [number, number])[0]])
			next = to.end + 1
		} else ranges.push(...member.set)
		items++
	}
	const set = union(ranges)
	return { class: true, end: next, items, set: negated ? complement(set) : set }
}
