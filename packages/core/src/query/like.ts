/**
 * PostgREST like/ilike: `*` is the wildcard, `%` and `_` are literals.
 * Expand stars only after escaping SQL LIKE specials.
 */
function likePattern(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_").replace(/\*/g, "%")
}

export { likePattern }
