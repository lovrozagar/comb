/**
 * The write rules of the destructive-change gate. A DELETE, UPDATE or MERGE is read at every
 * depth, a CTE, a subquery or a rule's action included, and a WHERE that holds for every row
 * (`true`, `1 = 1`, `id = id`, or a disjunct of those) counts as none.
 */
import type { Finding } from "./classify-alter.ts"
import { topLevel } from "./sql-code.ts"

const VOLATILE_WRITE = /^(?:WITH\b.*?\b)?(DELETE|UPDATE)\b(.*)$/i
const QUOTED_NAME = /"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g

/** `code` without its outer parentheses: `((a))` is `a` */
function unwrapped(code: string): string {
	let text = code.trim()
	while (text.startsWith("(") && text.endsWith(")") && topLevel(text.slice(1, -1)) === text.slice(1, -1)) {
		text = text.slice(1, -1).trim()
	}
	return text
}

/** Whether a condition holds for every row: `true`, `NOT false`, `1 = 1`, `id = id`, or a disjunct of those */
function alwaysTrue(condition: string): boolean {
	const blanked = topLevel(condition)
	const disjuncts: string[] = []
	let start = 0
	for (const match of blanked.matchAll(/\bOR\b/gi)) {
		disjuncts.push(condition.slice(start, match.index))
		start = match.index + match[0].length
	}
	disjuncts.push(condition.slice(start))
	return disjuncts.some((part) => {
		const text = unwrapped(part)
		if (text !== part.trim() && text !== condition.trim() && alwaysTrue(text)) return true
		const equal = /^(\S+?)\s*=\s*(\S+)$/.exec(text)
		return /^(?:TRUE|NOT FALSE)$/i.test(text) || (equal !== null && equal[1] === equal[2])
	})
}

/** A write's own finding: unsafe when its top-level WHERE is missing or always true, else cautious */
function ownWriteFinding(code: string): Finding | undefined {
	if (/^MERGE\b/i.test(code)) return { level: /\bTHEN DELETE\b/i.test(code) ? "unsafe" : "cautious" }
	/* a quoted name is no keyword: blank it, keeping each offset */
	const bare = topLevel(code.replace(QUOTED_NAME, (name) => "_".repeat(name.length)))
	const write = VOLATILE_WRITE.exec(bare)
	if (write === null) return undefined
	const where = /\bWHERE\b/i.exec(bare)
	if (where === null) return { level: "unsafe" }
	const end = /\bRETURNING\b/i.exec(bare.slice(where.index))
	const condition = code.slice(where.index + 5, end === null ? undefined : where.index + end.index)
	return { level: alwaysTrue(condition) ? "unsafe" : "cautious" }
}

/** The parenthesized groups of `code` at its first depth, each without its parentheses */
function groups(code: string): string[] {
	const out: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < code.length; i++) {
		if (code[i] === "(" && depth++ === 0) start = i + 1
		else if (code[i] === ")" && --depth === 0) out.push(code.slice(start, i).trim())
	}
	return out
}

/**
 * Each DELETE, UPDATE or MERGE in `code`, at any depth (a CTE, a subquery, a rule's action):
 * unsafe without a WHERE that filters (or with a MERGE delete), else cautious
 */
function writeFindings(code: string): Finding[] {
	const own = ownWriteFinding(code)
	const nested = groups(code).flatMap((group) =>
		/^(?:WITH|DELETE|UPDATE|MERGE)\b/i.test(group) ? writeFindings(group) : groups(group).flatMap(writeFindings),
	)
	return own === undefined ? nested : [own, ...nested]
}

export { writeFindings }
