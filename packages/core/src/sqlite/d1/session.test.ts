import type { D1Database } from "@cloudflare/workers-types"
import { describe, expect, it, vi } from "vitest"
import { openD1Session } from "./session.ts"

function mockD1(hasWithSession = true): D1Database {
	const session = {
		getBookmark: vi.fn().mockReturnValue("bk-123"),
		withSession: vi.fn(),
	}
	const d1: Record<string, unknown> = {
		batch: vi.fn(),
		dump: vi.fn(),
		exec: vi.fn(),
		prepare: vi.fn(),
	}
	if (hasWithSession) {
		d1.withSession = vi.fn().mockReturnValue(session)
	}
	return d1 as unknown as D1Database
}

describe("openD1Session", () => {
	it("opens on the primary by default, so a read sees every write before it (C6)", () => {
		const d1 = mockD1(true)
		const result = openD1Session(d1)

		expect(d1.withSession).toHaveBeenCalledWith("first-primary")
		expect(result.session).toBeDefined()
		expect(result.client).toBe(result.session)
	})

	it("opens on the nearest replica only when asked", () => {
		const d1 = mockD1(true)
		openD1Session(d1, { constraint: "first-unconstrained" })

		expect(d1.withSession).toHaveBeenCalledWith("first-unconstrained")
	})

	it("continues from a bookmark, and reads an empty one as none", () => {
		const d1 = mockD1(true)
		openD1Session(d1, { bookmark: "bk-456" })
		openD1Session(d1, { bookmark: "", constraint: "first-unconstrained" })

		expect(d1.withSession).toHaveBeenNthCalledWith(1, "bk-456")
		expect(d1.withSession).toHaveBeenNthCalledWith(2, "first-unconstrained")
	})

	it("falls back to raw D1 when withSession unavailable (miniflare)", () => {
		const d1 = mockD1(false)
		const result = openD1Session(d1)

		expect(result.client).toBe(d1)
		expect(result.session).toBeUndefined()
	})
})
