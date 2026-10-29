import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types"
type SessionHandle =
	| { client: D1Database; session: undefined }
	| { client: D1DatabaseSession; session: D1DatabaseSession }

/**
 * Where a session's first query reads: the primary, which has every write, or the nearest replica,
 * which may lag behind one the app just made
 */
type SessionConstraint = "first-primary" | "first-unconstrained"

type SessionOptions = {
	/** a bookmark an earlier session handed back: the session reads at least that far */
	bookmark?: string | undefined
	/** where to start without a bookmark; the primary unless a read may lag (default "first-primary") */
	constraint?: SessionConstraint | undefined
}

/**
 * Open a D1 session for read-after-write consistency: on a bookmark when one is given, else on the
 * primary, or on the nearest replica when `constraint` says a read may lag. Falls back to the raw
 * D1Database when withSession is unavailable (miniflare without sessions).
 *
 * Framework-agnostic — consumers wire this into their middleware. `client` is the session, or the
 * raw D1Database where there is none: drizzle() takes either, and a consumer's own helper types it
 * as drizzle's `AnyD1Database` to take both.
 */
function openD1Session(d1: D1Database, { bookmark, constraint = "first-primary" }: SessionOptions = {}): SessionHandle {
	if (typeof d1.withSession !== "function") {
		return { client: d1, session: undefined }
	}
	const session = d1.withSession(bookmark || constraint)
	return { client: session, session }
}

export { openD1Session, type SessionConstraint, type SessionHandle, type SessionOptions }
