/**
 * PostgREST like/ilike: `*` is the wildcard, every other character is literal.
 *
 * `ilike` lowers to SQL LIKE (ASCII case-insensitive in SQLite), so LIKE's own
 * specials `%` and `_` are escaped before `*` expands to `%`.
 */
function likePattern(value: string): string {
	return escapeLike(value).replace(/\*/g, "%")
}

/**
 * `like` lowers to SQLite GLOB, which is case-sensitive. GLOB has no escape
 * character: `?` and `[` are made literal by wrapping them in a one-character
 * class, and `*` stays the wildcard.
 */
function globPattern(value: string): string {
	return value.replace(/\[/g, "[[]").replace(/\?/g, "[?]")
}

/**
 * `text` as a literal inside a LIKE pattern written with `ESCAPE '\\'`: the escape character and
 * LIKE's own specials `%` and `_` each escaped, so `%${escapeLike(term)}%` finds `term` as written
 */
function escapeLike(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

/** A value's stars only at its ends: whether each end is open, and the text between */
const FIXED: RegExp = /^(\**)([^*]*)(\**)$/

/** The pattern SQLite matches `value` with under `operator`, or null for a fixed text, which is found with none (U21) */
const patternOf = (operator: "like" | "ilike", value: string): string | null =>
	FIXED.test(value) ? null : operator === "like" ? globPattern(value) : likePattern(value)

export { escapeLike, FIXED, globPattern, likePattern, patternOf }
