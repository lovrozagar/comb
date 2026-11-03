import type { D1DatabaseLike, SessionOf } from "./d1-types.ts"

/** A session opened on `D`, or `D` itself where there is none: each in the caller's own type (K3 of r21) */
type SessionHandle<D extends D1DatabaseLike = D1DatabaseLike> =
	| { client: D; session: undefined }
	| { client: SessionOf<D>; session: SessionOf<D> }

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
function openD1Session<D extends D1DatabaseLike>(
	d1: D,
	{ bookmark, constraint = "first-primary" }: SessionOptions = {},
): SessionHandle<D> {
	if (typeof d1.withSession !== "function") {
		return { client: d1, session: undefined }
	}
	/* the session `D`'s own withSession types, which the structural bound cannot name */
	const session = d1.withSession(bookmark || constraint) as SessionOf<D>
	return { client: session, session }
}

export { openD1Session, type SessionConstraint, type SessionHandle, type SessionOptions }
