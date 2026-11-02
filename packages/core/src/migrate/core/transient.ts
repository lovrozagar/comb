/** What comb retries: a failure the connection, not the statement, caused */

// lookup-table: the codes Node and undici give a connection that failed, timed out or was cut
const NETWORK_CODES: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EPIPE",
	"ETIMEDOUT",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
])

/**
 * Whether `error`, or an error it was caused by, failed transiently, read from its structured fields
 * alone: an HTTP status of 429 or 5xx (hrana's HttpServerError, under libsql's LibsqlError), or a
 * network code (undici's `fetch failed` carries it in its cause). A SQLite code never is, and no
 * message is read: a SQL error that quotes "429" is not a rate limit (S7 of the 0.15.0 review).
 */
function isTransient(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false
	const { cause, code, status } = error as { cause?: unknown; code?: unknown; status?: unknown }
	if (typeof code === "string" && code.startsWith("SQLITE_")) return false
	if (typeof status === "number" && (status === 429 || status >= 500)) return true
	return (typeof code === "string" && NETWORK_CODES.has(code)) || isTransient(cause)
}

export { isTransient }
