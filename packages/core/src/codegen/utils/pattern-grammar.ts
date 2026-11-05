/*
 * The grammar a pattern may hold, as an allowlist (AA4-1 of r24): literals, the escapes and classes
 * pattern-escape.ts takes, anchors, groups (, (?: and (?<name>, alternation, and counts written
 * without a leading zero. A source past it, or past an engine's size limits, is refused.
 */

import { bracket, escapeSet } from "./pattern-class.ts"
import { DOT, LOOKAROUND, UNREAD, Unportable, refuse } from "./pattern-escape.ts"
import { utf8Length, utf8Weight } from "./pattern-unicode.ts"

/**
 * What a part of a pattern costs each engine. `go` is the largest product of the counts in it, which
 * Go's RE2 holds at 1000. `height` is the nesting Rust's regex counts, at most 250: a level for each
 * group, count, alternation and concatenation of more than one, and class. `rust` bounds its compiled
 * size in units of one ASCII literal.
 */
type Shape = { go: number; height: number; rust: number }

type Cursor = { at: number; names: Set<string>; open: number; readonly source: string }

/*
 * Rust regex 1.13.1 refuses a pattern compiled past 10 MiB. Measured by compiling repeated
 * constructs there and bisecting the count at the limit: an ASCII literal costs 1 unit and the limit
 * falls between 324000 and 327000 units, so 300000 keeps an 8% margin. Each other cost below is at
 * least the most that construct measured per unit; a class, at most 1.064 per byte of the UTF-8
 * sequences it compiles to over 120 random classes, costs 1.25 per byte, with no sharing assumed.
 */
const BUDGET = 300_000
const GROUP_COST = 3
const BRANCH_COST = 3
const REPEAT_COST = 3
const CLASS_COST = (weight: number) => 3 + 1.25 * weight
const MOST_NESTED = 250
const MOST_COUNT = 1000

const LEAF: Shape = { go: 1, height: 0, rust: 1 }

const GROUP = (text: string) =>
	`${text}, a group other than (, (?: and (?<name>, which Node 22, Go's RE2 or Rust's regex refuses or reads as another rule: write the rule with those`

const NESTED =
	"groups, counts and alternatives nested past 250 levels, which Rust's regex refuses: write the rule with less nesting"

/* the group opening at the cursor: whether it captures, and its length */
function opening(cursor: Cursor): { captures: boolean; length: number } {
	const rest = cursor.source.slice(cursor.at, cursor.at + 64)
	const look = LOOKAROUND.exec(rest)
	if (look !== null) refuse(`${look[0]}, a lookaround, ${UNREAD}`)
	if (!rest.startsWith("(?")) return { captures: true, length: 1 }
	if (rest.startsWith("(?:")) return { captures: false, length: 3 }
	const named = /^\(\?<([^>]*)>/.exec(cursor.source.slice(cursor.at))
	if (named === null) refuse(GROUP((/^\(\?[^:)]*[:)]?/.exec(rest) as RegExpExecArray)[0]))
	const [text, name] = named as unknown as [string, string]
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
		refuse(
			`${text}, a group name past ASCII letters, digits and _, which Go's RE2 refuses: name the group with those, a letter or _ first`,
		)
	if (cursor.names.has(name))
		refuse(
			`${text} twice, a group name used again, which Node 22, Go's RE2 and Rust's regex refuse: give each group its own name`,
		)
	cursor.names.add(name)
	return { captures: true, length: text.length }
}

function group(cursor: Cursor): Shape {
	const { captures, length } = opening(cursor)
	if (++cursor.open > MOST_NESTED) refuse(NESTED)
	cursor.at += length
	const inner = alternation(cursor)
	cursor.open--
	cursor.at++
	return { go: inner.go, height: inner.height + 1, rust: inner.rust + (captures ? GROUP_COST : 0) }
}

/* a class or an escape read at the cursor, the cursor moved past it */
function classShape(cursor: Cursor, read: ReturnType<typeof bracket>, bracketed: boolean): Shape {
	cursor.at = read.end + 1
	if (!read.class) return { ...LEAF, rust: utf8Length((read.set[0] as readonly [number, number])[0]) }
	return { go: 1, height: bracketed ? (read.items > 1 ? 2 : 1) : 0, rust: CLASS_COST(utf8Weight(read.set)) }
}

function atom(cursor: Cursor): Shape {
	const { source, at } = cursor
	const char = source[at] as string
	if (char === "(") return group(cursor)
	if (char === "[") return classShape(cursor, bracket(source, at), true)
	if (char === "\\") return classShape(cursor, escapeSet(source, at), false)
	if (char === ".") refuse(DOT)
	const code = source.codePointAt(at) as number
	cursor.at += code > 0xffff ? 2 : 1
	return { ...LEAF, rust: char === "^" || char === "$" ? 1 : utf8Length(code) }
}

/* a {…} count at the cursor, applied to `inner` */
function counted(cursor: Cursor, inner: Shape): Shape {
	const [text, min, comma, max] = /^\{([0-9]+)(,)?([0-9]*)\}/.exec(cursor.source.slice(cursor.at)) as unknown as [
		string,
		string,
		string | undefined,
		string,
	]
	cursor.at += text.length
	if ([min, max].some((digits) => /^0[0-9]/.test(digits)))
		refuse(
			`${text}, a count with a leading zero, which Go's RE2 reads as the text ${text}: write ${text.replaceAll(/[0-9]+/g, (digits) => String(Number(digits)))}`,
		)
	const [n, m] = [Number(min), comma === undefined ? Number(min) : max === "" ? null : Number(max)]
	if (Math.max(n, m ?? 0) > MOST_COUNT)
		refuse(`${text}, a count past 1000, which Go's RE2 does not compile: write the rule with a count of at most 1000`)
	/* Go's RE2 bounds an unbounded count by its least, and reads none of what a count of at most 0 holds */
	const bound = m ?? n
	const go = bound === 0 ? 1 : bound * inner.go
	if (go > MOST_COUNT)
		refuse(
			`${text}, a count whose product with the counts inside it, ${go}, is past 1000, which Go's RE2 does not compile: write nested counts whose product is at most 1000`,
		)
	const rust = m === null ? (n + 1) * inner.rust + REPEAT_COST : n * inner.rust + (m - n) * (inner.rust + REPEAT_COST)
	return { go, height: inner.height + 1, rust: Math.max(1, rust) }
}

function quantified(cursor: Cursor, inner: Shape): Shape {
	const char = cursor.source[cursor.at]
	let shape: Shape
	if (char === "{") shape = counted(cursor, inner)
	else if (char === "*" || char === "+" || char === "?") {
		cursor.at++
		shape = { go: inner.go, height: inner.height + 1, rust: inner.rust + REPEAT_COST }
	} else return inner
	/* a lazy count matches as the greedy one does, at the same size */
	if (cursor.source[cursor.at] === "?") cursor.at++
	return shape
}

function sequence(cursor: Cursor): Shape {
	const parts: Shape[] = []
	for (let char = cursor.source[cursor.at]; char !== undefined && char !== "|" && char !== ")";) {
		parts.push(quantified(cursor, atom(cursor)))
		char = cursor.source[cursor.at]
	}
	if (parts.length === 0) return LEAF
	return {
		go: Math.max(...parts.map((part) => part.go)),
		height: Math.max(...parts.map((part) => part.height)) + (parts.length > 1 ? 1 : 0),
		rust: parts.reduce((sum, part) => sum + part.rust, 0),
	}
}

function alternation(cursor: Cursor): Shape {
	const branches = [sequence(cursor)]
	while (cursor.source[cursor.at] === "|") {
		cursor.at++
		branches.push(sequence(cursor))
	}
	if (branches.length === 1) return branches[0] as Shape
	return {
		go: Math.max(...branches.map((branch) => branch.go)),
		height: Math.max(...branches.map((branch) => branch.height)) + 1,
		rust: branches.reduce((sum, branch) => sum + branch.rust + BRANCH_COST, 0),
	}
}

/**
 * What `source`, the engine's own as comb publishes it, holds that an engine comb names reads
 * otherwise, or not at all, as the error states it; null for none
 */
export function unportableOf(source: string): string | null {
	try {
		const shape = alternation({ at: 0, names: new Set(), open: 0, source })
		if (shape.height > MOST_NESTED) refuse(NESTED)
		if (shape.rust > BUDGET)
			refuse(
				"counts and classes too large for Rust's regex, which compiles a pattern into at most 10 MiB, so a validator there refuses the whole document: repeat a large class with + or * and bound the length with max, or write smaller counts",
			)
		return null
	} catch (error) {
		if (error instanceof Unportable) return error.message
		throw error
	}
}
