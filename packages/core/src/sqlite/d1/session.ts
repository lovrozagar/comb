import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types"
type SessionHandle =
	| { client: D1Database; session: undefined }
	| { client: D1DatabaseSession; session: D1DatabaseSession }

/**
 * Open a D1 session with bookmark support for read-after-write consistency.
 * Uses provided bookmark when available, falls back to first-unconstrained.
 * Falls back to raw D1Database if withSession unavailable (miniflare).
 *
 * Framework-agnostic — consumers wire this into their middleware.
 * Returns client as D1Database so drizzle() produces consistent types.
 */
function openD1Session(d1: D1Database, bookmark?: string): SessionHandle {
	if (typeof d1.withSession !== "function") {
		return { client: d1, session: undefined }
	}
	const session = bookmark ? d1.withSession(bookmark) : d1.withSession("first-unconstrained")
	return { client: session, session }
}

export { openD1Session, type SessionHandle }
