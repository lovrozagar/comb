import type { D1Database } from "@cloudflare/workers-types"
import { describe, expect, it, vi } from "vitest"
import { openD1Session } from "../../../../src/sqlite/d1/session.ts"

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
	it("returns session when withSession available", () => {
		const d1 = mockD1(true)
		const result = openD1Session(d1)

		expect(d1.withSession).toHaveBeenCalledWith("first-unconstrained")
		expect(result.session).toBeDefined()
		expect(result.client).toBe(result.session)
	})

	it("uses provided bookmark", () => {
		const d1 = mockD1(true)
		openD1Session(d1, "bk-456")

		expect(d1.withSession).toHaveBeenCalledWith("bk-456")
	})

	it("falls back to raw D1 when withSession unavailable (miniflare)", () => {
		const d1 = mockD1(false)
		const result = openD1Session(d1)

		expect(result.client).toBe(d1)
		expect(result.session).toBeUndefined()
	})
})
