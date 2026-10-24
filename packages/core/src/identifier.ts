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

const bytesOf = (text: string): number => new TextEncoder().encode(text).length

/**
 * The name Postgres makes for a constraint it names itself, `<name1>_<name2>_<label>`, as its
 * makeObjectName does: each part is the identifier Postgres keeps of it, the longer cut by a byte
 * at a time while the whole passes 63 bytes, then each part clipped to a whole character. Postgres
 * appends a number when the name is taken, which only the database knows.
 */
function pgObjectName(name1: string, name2: string, label: string): string {
	const [first, second] = [pgIdentifier(name1), pgIdentifier(name2)]
	let [bytes1, bytes2] = [bytesOf(first), bytesOf(second)]
	const available = PG_IDENTIFIER_BYTES - (label.length + 1) - 1
	while (bytes1 + bytes2 > available) {
		if (bytes1 > bytes2) bytes1--
		else bytes2--
	}
	return `${truncateUtf8(first, bytes1)}_${truncateUtf8(second, bytes2)}_${label}`
}

export { PG_IDENTIFIER_BYTES, pgIdentifier, pgObjectName, truncateUtf8 }
