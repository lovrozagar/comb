/*
 * Engines on other Unicode versions read one \p{…} name as other sets (Rust's regex
 * 1.13.1 and Node 22 on Unicode 16, Go and Node 24 on 17), so comb publishes each General_Category as
 * the ranges of the codegen runtime's tables, and every engine reads one fixed set.
 */

import { bracket, escapeSet } from "./pattern-class.ts"
import { hexOf } from "./pattern-escape.ts"
import type { CodeSet } from "./pattern-unicode.ts"

/* U+2028 and U+2029, which a regex literal holds only as an escape and Go's RE2 reads no \u escape of:
   \p{Zl} and \p{Zp} are each that one character in every Unicode version, so they stay by name */
const LINE_SEPARATORS: ReadonlyArray<readonly [number, string]> = [
	[0x2028, "\\p{Zl}"],
	[0x2029, "\\p{Zp}"],
]

/* `code` as a class member every engine reads alike: a control as \xHH, a class syntax character escaped */
function memberText(code: number): string {
	if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return hexOf(code)
	const char = String.fromCodePoint(code)
	/* & and ~ have no escape under u, and Rust reads either doubled as a set operation */
	if (char === "&" || char === "~") return hexOf(code)
	return "\\]-[^".includes(char) ? `\\${char}` : char
}

/** `set` as the members of a class: its ranges, with U+2028 and U+2029 by name */
export function rangesText(set: CodeSet): string {
	let text = ""
	let named = ""
	for (const [lo, hi] of set) {
		let from = lo
		for (const [code, name] of LINE_SEPARATORS)
			if (code >= from && code <= hi) {
				if (code > from) text += rangeText(from, code - 1)
				named += name
				from = code + 1
			}
		if (from <= hi) text += rangeText(from, hi)
	}
	return text + named
}

const rangeText = (lo: number, hi: number): string =>
	lo === hi ? memberText(lo) : `${memberText(lo)}${hi === lo + 1 ? "" : "-"}${memberText(hi)}`

/* a \p{…} or \P{…} in `text`, which the published source writes as its ranges; \p{Zl} and \p{Zp} stay */
const CATEGORY = /\\[pP]\{(?!Z[lp]\})/u

/**
 * `source`, which the grammar took, with each class or escape that holds a \p{…} or \P{…} written as
 * the one class of the ranges it matches, its negation folded in
 */
export function publishedSource(source: string): string {
	let out = ""
	for (let at = 0; at < source.length; at++) {
		const char = source[at] as string
		if (char !== "\\" && char !== "[") {
			out += char
			continue
		}
		const read = char === "[" ? bracket(source, at) : escapeSet(source, at)
		const text = source.slice(at, read.end + 1)
		out += CATEGORY.test(text) ? `[${rangesText(read.set)}]` : text
		at = read.end
	}
	return out
}
