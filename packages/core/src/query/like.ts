/**
 * PostgREST like/ilike: `*` is the wildcard, every other character is literal.
 *
 * `ilike` lowers to SQL LIKE (ASCII case-insensitive in SQLite), so LIKE's own
 * specials `%` and `_` are escaped before `*` expands to `%`.
 */
function likePattern(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/\*/g, "%")
}

/**
 * `like` lowers to SQLite GLOB, which is case-sensitive. GLOB has no escape
 * character: `?` and `[` are made literal by wrapping them in a one-character
 * class, and `*` stays the wildcard.
 */
function globPattern(value: string): string {
	return value.replace(/\[/g, "[[]").replace(/\?/g, "[?]")
}

export { globPattern, likePattern }
