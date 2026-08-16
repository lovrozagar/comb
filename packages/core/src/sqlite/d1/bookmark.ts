import type { D1DatabaseSession } from "@cloudflare/workers-types"
type TaggedBookmark = { bookmark: string; tag: string }

/**
 * Accumulates D1 sessions for later bookmark extraction.
 * Framework-agnostic — consumers create an instance per request
 * and wire getBookmarks() into their response pipeline.
 */
class BookmarkTracker {
	private sessions: Array<{ session: D1DatabaseSession; tag: string }> = []

	/** Register a session to be tracked for bookmark extraction */
	track(session: D1DatabaseSession, tag: string): void {
		this.sessions.push({ session, tag })
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
				/* session may not have committed — skip */
			}
		}
		return bookmarks
	}
}

export { BookmarkTracker, type TaggedBookmark }
