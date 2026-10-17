/**
 * SQLite identifier quoting: the only text `sql.raw` may splice in besides fixed SQL keywords.
 * A quoted identifier is never read as SQL, whatever it holds.
 */

/** `name` as a double-quoted SQLite identifier, embedded quotes doubled */
function quoteIdent(name: string): string {
	return `"${name.replaceAll('"', '""')}"`
}

export { quoteIdent }
