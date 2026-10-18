import { describe, expect, it } from "vitest"
import { createUlidFactory, generateId, generateUlid } from "./id.ts"

describe("generateUlid", () => {
	it("returns 26-character string", () => {
		const ulid = generateUlid()
		expect(ulid).toHaveLength(26)
	})

	it("uses valid Crockford base32 characters", () => {
		const valid = /^[0123456789abcdefghjkmnpqrstvwxyz]{26}$/
		for (let i = 0; i < 100; i++) {
			expect(generateUlid()).toMatch(valid)
		}
	})

	it("is unique across calls", () => {
		const ids = new Set<string>()
		for (let i = 0; i < 1000; i++) {
			ids.add(generateUlid())
		}
		expect(ids.size).toBe(1000)
	})

	it("is lexicographically sortable by time", async () => {
		const first = generateUlid()
		await new Promise((r) => setTimeout(r, 2))
		const second = generateUlid()
		expect(first < second).toBe(true)
	})
})

describe("generateId", () => {
	it("returns prefix_ulid format", () => {
		const id = generateId("usr")
		expect(id).toMatch(/^usr_[0-9a-z]{26}$/)
	})

	it("uses the given prefix", () => {
		expect(generateId("org").startsWith("org_")).toBe(true)
		expect(generateId("prj").startsWith("prj_")).toBe(true)
		expect(generateId("bat").startsWith("bat_")).toBe(true)
	})

	it("generates unique IDs", () => {
		const ids = new Set<string>()
		for (let i = 0; i < 100; i++) {
			ids.add(generateId("test"))
		}
		expect(ids.size).toBe(100)
	})
})

/** A factory on a clock the test moves */
function onClock(start: number) {
	const clock = { now: start }
	return { clock, factory: createUlidFactory({ now: () => clock.now }) }
}

describe("createUlidFactory (S-L3)", () => {
	it("is strictly increasing within one millisecond", () => {
		const { factory } = onClock(1_700_000_000_000)
		const ids = Array.from({ length: 1000 }, () => factory.ulid())
		expect(ids.every((id, i) => i === 0 || id > (ids[i - 1] as string))).toBe(true)
		expect(new Set(ids.map((id) => id.slice(0, 10))).size).toBe(1)
	})

	it("keeps increasing when the clock steps back, on the last time it issued", () => {
		const { clock, factory } = onClock(1_700_000_000_000)
		const before = factory.ulid()
		clock.now -= 1000
		const after = factory.ulid()
		expect(after > before).toBe(true)
		expect(after.slice(0, 10)).toBe(before.slice(0, 10))
	})

	it("starts a fresh random part when the clock moves on", () => {
		const { clock, factory } = onClock(1_700_000_000_000)
		const before = factory.ulid()
		clock.now += 1
		const after = factory.ulid()
		expect(after.slice(0, 10) > before.slice(0, 10)).toBe(true)
	})

	it("moves to the next millisecond rather than wrap a full random part", () => {
		const { factory } = onClock(1_700_000_000_000)
		const random = new Uint8Array(16).fill(31)
		const full = createUlidFactory({ now: () => 1_700_000_000_000, random: (bytes) => bytes.set(random) })
		const first = full.ulid()
		expect(first.slice(10)).toBe("zzzzzzzzzzzzzzzz")
		const next = full.ulid()
		expect(next > first).toBe(true)
		expect(next.slice(0, 10) > first.slice(0, 10)).toBe(true)
		expect(factory.ulid()).toHaveLength(26)
	})

	it("runs on the real clock and Web Crypto by default", () => {
		const factory = createUlidFactory()
		const [a, b] = [factory.ulid(), factory.ulid()]
		expect(a).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/)
		expect(b > a).toBe(true)
	})

	it("issues prefixed ids the same way, and checks the prefix", () => {
		const { factory } = onClock(1_700_000_000_000)
		const [a, b] = [factory.id("usr"), factory.id("usr")]
		expect(a).toMatch(/^usr_[0-9a-hjkmnp-tv-z]{26}$/)
		expect((b as string) > (a as string)).toBe(true)
		expect(() => factory.id("Bad")).toThrow("Invalid entity prefix")
	})
})
