/**
 * A Postgres driver's lost, refused or timed-out connection, which carries no SQLSTATE (Q14 of r17,
 * R2 of plan 16's review): pgErrorHandler answers it as the 503 a retry may fix.
 */

/* the drivers' own codes for a connection refused, lost or timed out, which carry no SQLSTATE (Q14 of r17) */
// lookup-table: the codes connectionLost reads
const CONNECTION_CODES: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"CONNECT_TIMEOUT",
	"CONNECTION_CLOSED",
	"CONNECTION_DESTROYED",
	"CONNECTION_ENDED",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"ERR_POSTGRES_IDLE_TIMEOUT",
	"ERR_POSTGRES_LIFETIME_TIMEOUT",
	"ETIMEDOUT",
])

/*
 * node-postgres's and pg-pool's words for a connection lost, timed out or not to be had, which they
 * throw with no code (R2 of plan 16's review). Their words for the app's own end() or its
 * query_timeout are no lost connection, and stay unclassified
 */
// lookup-table: the messages connectionLost reads
const CONNECTION_MESSAGES: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"Client has encountered a connection error and is not queryable",
	"Connection terminated due to connection timeout",
	"Connection terminated unexpectedly",
	"timeout exceeded when trying to connect",
	"timeout expired",
])

/**
 * Whether `error`, or one under it on `.cause`, is a driver's lost connection: postgres.js's and
 * node's codes, Bun.SQL's ERR_POSTGRES_CONNECTION_* and timeouts, node-postgres's and pg-pool's
 * words. A host that does not exist (ENOTFOUND) is a misconfiguration, no lost connection. The 08xxx
 * SQLSTATEs stay in RESOURCE for a libpq-based driver, which sends them
 */
export function connectionLost(error: unknown): boolean {
	for (let link = error, depth = 0; link instanceof Error && depth < 8; link = link.cause, depth++) {
		const { code } = link as { code?: unknown }
		if (typeof code === "string" && (CONNECTION_CODES.has(code) || code.startsWith("ERR_POSTGRES_CONNECTION_")))
			return true
		if (code === undefined && CONNECTION_MESSAGES.has(link.message)) return true
	}
	return false
}
