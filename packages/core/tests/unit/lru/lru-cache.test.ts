import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LruCache } from "../../../src/lru.ts"

describe("LruCache", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("stores and retrieves values", () => {
		const cache = new LruCache<string, number>({ maxSize: 10 })
		cache.set("a", 1)
		expect(cache.get("a")).toBe(1)
	})

	it("returns undefined for missing keys", () => {
		const cache = new LruCache<string, number>({ maxSize: 10 })
		expect(cache.get("missing")).toBeUndefined()
	})

	it("evicts LRU entry when full", () => {
		const cache = new LruCache<string, number>({ maxSize: 2 })
		cache.set("a", 1)
		cache.set("b", 2)
		cache.set("c", 3)
		expect(cache.get("a")).toBeUndefined()
		expect(cache.get("b")).toBe(2)
		expect(cache.get("c")).toBe(3)
	})

	it("promotes accessed entries", () => {
		const cache = new LruCache<string, number>({ maxSize: 2 })
		cache.set("a", 1)
		cache.set("b", 2)
		cache.get("a") /* promote a */
		cache.set("c", 3) /* should evict b */
		expect(cache.get("a")).toBe(1)
		expect(cache.get("b")).toBeUndefined()
	})

	it("expires entries after soft TTL", () => {
		const cache = new LruCache<string, number>({ maxSize: 10, ttlMs: 1000 })
		cache.set("a", 1)
		vi.advanceTimersByTime(1001)
		expect(cache.get("a")).toBeUndefined()
	})

	it("returns stale entries via getWithMeta between soft and hard TTL", () => {
		const cache = new LruCache<string, number>({
			hardTtlMs: 5000,
			maxSize: 10,
			ttlMs: 1000,
		})
		cache.set("a", 1)

		vi.advanceTimersByTime(500)
		const fresh = cache.getWithMeta("a")
		expect(fresh).toEqual({ stale: false, value: 1 })

		vi.advanceTimersByTime(600) /* now at 1100ms, past soft TTL */
		const stale = cache.getWithMeta("a")
		expect(stale).toEqual({ stale: true, value: 1 })

		vi.advanceTimersByTime(4000) /* now at 5100ms, past hard TTL */
		expect(cache.getWithMeta("a")).toBeUndefined()
	})

	it("hard-evicts expired entries on get()", () => {
		const cache = new LruCache<string, number>({
			hardTtlMs: 2000,
			maxSize: 10,
			ttlMs: 1000,
		})
		cache.set("a", 1)
		vi.advanceTimersByTime(2001)
		expect(cache.get("a")).toBeUndefined()
		expect(cache.size).toBe(0)
	})

	it("delete removes entry", () => {
		const cache = new LruCache<string, number>({ maxSize: 10 })
		cache.set("a", 1)
		expect(cache.delete("a")).toBe(true)
		expect(cache.get("a")).toBeUndefined()
	})

	it("clear empties cache", () => {
		const cache = new LruCache<string, number>({ maxSize: 10 })
		cache.set("a", 1)
		cache.set("b", 2)
		cache.clear()
		expect(cache.size).toBe(0)
	})

	it("has returns false for expired entries", () => {
		const cache = new LruCache<string, number>({ maxSize: 10, ttlMs: 100 })
		cache.set("a", 1)
		expect(cache.has("a")).toBe(true)
		vi.advanceTimersByTime(101)
		expect(cache.has("a")).toBe(false)
	})

	it("per-key TTL overrides default", () => {
		const cache = new LruCache<string, number>({ maxSize: 10, ttlMs: 1000 })
		cache.set("a", 1, 200)
		vi.advanceTimersByTime(201)
		expect(cache.get("a")).toBeUndefined()
	})
})
