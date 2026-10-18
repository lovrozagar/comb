/**
 * D1 sessions and bookmarks on Miniflare's D1: a session opened on a bookmark reads what the
 * write behind it wrote, and the tracker hands back one bookmark per tracked session.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BookmarkTracker } from "../../../src/sqlite/d1/bookmark.ts"
import { openD1Session } from "../../../src/sqlite/d1/session.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"

let d1: D1Harness

beforeEach(async () => {
	d1 = await d1Memory()
	await d1.CORE.exec("CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)")
})

afterEach(() => d1.dispose())

describe("openD1Session on Miniflare", () => {
	it("opens a session, and a later one on its bookmark reads the write", async () => {
		const first = openD1Session(d1.CORE)
		expect(first.session).toBeDefined()
		await first.client.prepare("INSERT INTO note VALUES (?, ?)").bind("n1", "hello").run()
		const bookmark = first.session?.getBookmark()
		expect(typeof bookmark).toBe("string")

		const later = openD1Session(d1.CORE, bookmark ?? undefined)
		const row = await later.client.prepare("SELECT body FROM note WHERE id = ?").bind("n1").first<{ body: string }>()
		expect(row?.body).toBe("hello")
	})
})

describe("BookmarkTracker on Miniflare", () => {
	it("hands back the bookmark of every tracked session that wrote, tagged", async () => {
		const tracker = new BookmarkTracker()
		const core = openD1Session(d1.CORE)
		await core.client.prepare("INSERT INTO note VALUES (?, ?)").bind("n2", "x").run()
		if (core.session === undefined) throw new Error("Miniflare D1 offers withSession")
		tracker.track(core.session, "core")

		const bookmarks = tracker.getBookmarks()
		expect(bookmarks).toEqual([{ bookmark: expect.any(String), tag: "core" }])
	})
})
