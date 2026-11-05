import type { D1SessionLike } from "./d1-types.ts"

/** A tracked session's bookmark, for the client to send back so its next request reads at least that far */
type TaggedBookmark = {
	/** the session's D1 bookmark, opaque; openD1Session given it as `bookmark` reads at least this far */
	bookmark: string
	/** the tag the session was tracked under, telling one database's bookmark from another's */
	tag: string
}

/**
 * Accumulates D1 sessions for later bookmark extraction.
 * Framework-agnostic — consumers create an instance per request
 * and wire getBookmarks() into their response pipeline.
 */
class BookmarkTracker {
	private sessions: Array<{ session: D1SessionLike; tag: string }> = []

	/**
	 * Register a session to be tracked for bookmark extraction. Takes openD1Session's `session` as
	 * it comes: undefined on a runtime without sessions, which has no bookmark to track.
	 */
	track(session: D1SessionLike | undefined, tag: string): void {
		if (session !== undefined) this.sessions.push({ session, tag })
	}

	/**
	 * Extract bookmarks from all tracked sessions.
	 * Call after the response is ready — bookmarks reflect the session's last write.
	 * Silently skips sessions that fail to produce a bookmark.
	 */
	getBookmarks(): TaggedBookmark[] {
		const bookmarks: TaggedBookmark[] = []
		for (const { session, tag } of this.sessions) {
			try {
				const bookmark = session.getBookmark()
				if (bookmark) {
					bookmarks.push({ bookmark, tag })
				}
			} catch {
				// reason: a session that never committed has no bookmark to hand on; the others still do
			}
		}
		return bookmarks
	}
}

export { BookmarkTracker, type TaggedBookmark }
