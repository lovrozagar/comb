/**
 * Postgres keeps at most 63 bytes of an identifier (NAMEDATALEN - 1) and silently cuts a longer
 * one, so a constraint is created, and its violation reported, under the cut name. A map entry
 * keyed by the declared name would never match; it is keyed by the name Postgres keeps.
 */

/** The bytes Postgres keeps of an identifier */
const PG_IDENTIFIER_BYTES = 63

/** `name` cut to at most `bytes` UTF-8 bytes, never inside a character */
function truncateUtf8(name: string, bytes: number): string {
	let out = ""
	let used = 0
	for (const char of name) {
		used += new TextEncoder().encode(char).length
		if (used > bytes) break
		out += char
	}
	return out
}

/** The name Postgres keeps of identifier `name` */
const pgIdentifier = (name: string): string => truncateUtf8(name, PG_IDENTIFIER_BYTES)

export { PG_IDENTIFIER_BYTES, pgIdentifier, truncateUtf8 }
