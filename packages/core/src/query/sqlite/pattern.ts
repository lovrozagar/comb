/**
 * The one lowering of `like` / `ilike` for SQLite. Every filter path calls this,
 * so the two operators cannot drift apart between builders.
 *
 * A value whose only `*` are at its ends is a fixed text to find, not a pattern (U21): it lowers
 * to `instr`, `substr` or `=`, which no length cap limits, where D1 refuses a LIKE or GLOB
 * pattern over 50 bytes. `like` stays case-sensitive, as GLOB is; `ilike` compares both sides
 * through `lower()`, ASCII as LIKE folds. A NULL column matches neither, as it matches no pattern.
 */
import { type SQL, type SQLWrapper, sql } from "drizzle-orm"

import { globPattern, likePattern } from "../like.ts"
import { countLiteral } from "./keyset.ts"

/** A value's stars only at its ends: whether each end is open, and the text between */
const FIXED = /^(\**)([^*]*)(\**)$/

/** `like` → GLOB (case-sensitive). `ilike` → LIKE (ASCII case-insensitive). A fixed text → a search for it. */
function patternToSQL(column: SQLWrapper, operator: "like" | "ilike", value: unknown): SQL {
	const raw = String(value)
	const fixed = FIXED.exec(raw)
	if (fixed !== null) return fixedToSQL(column, operator === "ilike", fixed)
	if (operator === "like") return sql`${column} GLOB ${globPattern(raw)}`
	return sql`${column} LIKE ${likePattern(raw)} ESCAPE '\\'`
}

/** A fixed text found in `column`: anywhere, at its start, at its end, or as all of it */
function fixedToSQL(column: SQLWrapper, folded: boolean, [, head, text, tail]: RegExpExecArray): SQL {
	const [opensStart, opensEnd] = [head !== "", tail !== ""]
	/* a value of stars alone matches any text, as `*` does; a NULL is no text */
	if (text === "" && (opensStart || opensEnd)) return sql`${column} IS NOT NULL`
	const side = folded ? sql`lower(${column})` : sql`${column}`
	const find = folded ? sql`lower(${text})` : sql`${text}`
	if (opensStart && opensEnd) return sql`instr(${side}, ${find}) > 0`
	/* the text bound once, its length written as SQLite's length() counts it, in code points, which
	   lower()'s ASCII fold keeps: a bound value the budget counts once (Q2 of the 0.14.1 review) */
	/* FIXED's middle group takes part in every match, an empty text included */
	const length = countLiteral([...(text as string)].length)
	if (opensEnd) return sql`substr(${side}, 1, ${length}) = ${find}`
	if (opensStart) return sql`substr(${side}, -${length}) = ${find}`
	/* the column's own collation never applies: GLOB compares bytes, and LIKE folds only through lower() here */
	return sql`${side} = ${find} COLLATE BINARY`
}

export { patternToSQL }
