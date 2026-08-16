import type { D1DatabaseSession } from "@cloudflare/workers-types"
import { describe, expect, it, vi } from "vitest"
import { BookmarkTracker } from "../../../../src/sqlite/d1/bookmark.ts"

function mockSession(bookmark: string | null): D1DatabaseSession {
	return {
		getBookmark: vi.fn().mockReturnValue(bookmark),
		withSession: vi.fn(),
	} as unknown as D1DatabaseSession
}

describe("BookmarkTracker", () => {
	it("returns empty array when no sessions tracked", () => {
		const tracker = new BookmarkTracker()
		expect(tracker.getBookmarks()).toEqual([])
	})

	it("extracts bookmarks from tracked sessions", () => {
		const tracker = new BookmarkTracker()
		tracker.track(mockSession("bk-core-1"), "core")
		tracker.track(mockSession("bk-shard-1"), "shard")

		const bookmarks = tracker.getBookmarks()
		expect(bookmarks).toEqual([
			{ bookmark: "bk-core-1", tag: "core" },
			{ bookmark: "bk-shard-1", tag: "shard" },
		])
	})

	it("skips sessions with null bookmark", () => {
		const tracker = new BookmarkTracker()
		tracker.track(mockSession("bk-core"), "core")
		tracker.track(mockSession(null), "shard")

		const bookmarks = tracker.getBookmarks()
		expect(bookmarks).toEqual([{ bookmark: "bk-core", tag: "core" }])
	})

	it("silently skips sessions that throw on getBookmark", () => {
		const tracker = new BookmarkTracker()
		const badSession = {
			getBookmark: vi.fn().mockImplementation(() => {
				throw new Error("session not committed")
			}),
		} as unknown as D1DatabaseSession
		tracker.track(badSession, "core")
		tracker.track(mockSession("bk-shard"), "shard")

		const bookmarks = tracker.getBookmarks()
		expect(bookmarks).toEqual([{ bookmark: "bk-shard", tag: "shard" }])
	})
})
