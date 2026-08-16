import type { D1Database, KVNamespace } from "@cloudflare/workers-types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShardRouter } from "../../../../../src/sqlite/d1/sharding/router.ts"
import type { ShardMapping } from "../../../../../src/sqlite/d1/sharding/types.ts"

/**
 * Minimal D1Database mock for testing.
 * ShardRouter uses drizzle(client) which calls prepare/bind/run — we mock at the D1 level.
 */
function mockD1(rows: Record<string, unknown>[] = []): D1Database {
	const stmt = {
		all: vi.fn().mockResolvedValue({ results: rows }),
		bind: vi.fn().mockReturnThis(),
		first: vi.fn().mockResolvedValue(rows[0] ?? null),
		raw: vi.fn().mockResolvedValue(rows),
		run: vi.fn().mockResolvedValue({ meta: {}, results: [], success: true }),
	}
	const session = {
		batch: vi.fn(),
		dump: vi.fn(),
		exec: vi.fn(),
		getBookmark: vi.fn().mockReturnValue("bk-test"),
		prepare: vi.fn().mockReturnValue(stmt),
		withSession: vi.fn(),
	}
	return {
		batch: vi.fn(),
		dump: vi.fn(),
		exec: vi.fn(),
		prepare: vi.fn().mockReturnValue(stmt),
		withSession: vi.fn().mockReturnValue(session),
	} as unknown as D1Database
}

function mockKV(data: Record<string, unknown> = {}): KVNamespace {
	return {
		delete: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockImplementation((key: string, _type: string) => {
			return Promise.resolve(data[key] ?? null)
		}),
		getWithMetadata: vi.fn(),
		list: vi.fn(),
		put: vi.fn().mockResolvedValue(undefined),
	} as unknown as KVNamespace
}

function mockWaitUntil(): {
	calls: Promise<unknown>[]
	ctx: { waitUntil: (p: Promise<unknown>) => void }
} {
	const calls: Promise<unknown>[] = []
	return {
		calls,
		ctx: { waitUntil: (p: Promise<unknown>) => calls.push(p) },
	}
}

describe("ShardRouter", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("constructs with defaults", () => {
		const router = new ShardRouter({ totalShards: 4 })
		expect(router).toBeDefined()
	})

	it("constructs with custom config", () => {
		const log = vi.fn()
		const router = new ShardRouter({
			kvTtlSeconds: 120,
			log,
			lruHardTtlMs: 30 * 60 * 1000,
			lruMaxSize: 500,
			lruTtlMs: 10 * 60 * 1000,
			maxOrgsPerShard: 1000,
			totalShards: 8,
		})
		expect(router).toBeDefined()
	})

	it("getHandle returns D1 binding from env", () => {
		const router = new ShardRouter({ totalShards: 4 })
		const mockDb = {} as D1Database
		const mapping: ShardMapping = {
			createdAt: Date.now(),
			deletedAt: null,
			driver: "d1",
			orgId: "org-1",
			shardId: 0,
			target: "0",
			updatedAt: Date.now(),
		}
		const handle = router.getHandle(mapping, { SHARD_DB_0: mockDb })
		expect(handle.driver).toBe("d1")
		expect(handle.handle).toBe(mockDb)
	})

	it("getHandle throws for missing binding", () => {
		const router = new ShardRouter({ totalShards: 4 })
		const mapping: ShardMapping = {
			createdAt: Date.now(),
			deletedAt: null,
			driver: "d1",
			orgId: "org-1",
			shardId: 5,
			target: "5",
			updatedAt: Date.now(),
		}
		expect(() => router.getHandle(mapping, {})).toThrow("Missing D1 binding: SHARD_DB_5")
	})

	it("invalidate clears LRU and KV", async () => {
		const router = new ShardRouter({ totalShards: 4 })
		const kv = mockKV()
		await router.invalidate("org-1", kv)
		expect(kv.delete).toHaveBeenCalledWith("shard:org-1")
	})

	it("resolve returns undefined when no mapping exists (KV miss, D1 miss)", async () => {
		const router = new ShardRouter({ totalShards: 4 })
		const d1 = mockD1([])
		const kv = mockKV()
		const { ctx } = mockWaitUntil()

		const result = await router.resolve("org-new", { coreDb: d1, kv }, ctx)
		expect(result).toBeUndefined()
	})

	it("resolve returns mapping from KV cache", async () => {
		const router = new ShardRouter({ totalShards: 4 })
		const d1 = mockD1()
		const mapping: ShardMapping = {
			createdAt: 1000,
			deletedAt: null,
			driver: "d1",
			orgId: "org-1",
			shardId: 0,
			target: "0",
			updatedAt: 1000,
		}
		const kv = mockKV({ "shard:org-1": mapping })
		const { ctx } = mockWaitUntil()

		const result = await router.resolve("org-1", { coreDb: d1, kv }, ctx)
		expect(result).toEqual(mapping)
	})

	it("resolve returns stale LRU entry and triggers background revalidation", async () => {
		const router = new ShardRouter({
			lruHardTtlMs: 10_000,
			lruTtlMs: 1_000,
			totalShards: 4,
		})
		const mapping: ShardMapping = {
			createdAt: 1000,
			deletedAt: null,
			driver: "d1",
			orgId: "org-1",
			shardId: 0,
			target: "0",
			updatedAt: 1000,
		}
		const d1 = mockD1()
		const kv = mockKV({ "shard:org-1": mapping })
		const { calls, ctx } = mockWaitUntil()

		/* Prime LRU via KV */
		await router.resolve("org-1", { coreDb: d1, kv }, ctx)

		/* Advance past soft TTL but before hard TTL */
		vi.advanceTimersByTime(1_500)

		const result = await router.resolve("org-1", { coreDb: d1, kv }, ctx)
		expect(result).toEqual(mapping)
		/* Background revalidation triggered */
		expect(calls.length).toBeGreaterThan(0)
	})
})

describe("ShardRouter — allocation", () => {
	/* The shard-count query comes back through D1's raw() form — positional
	   arrays of [count, shard_id] — which drizzle maps onto the select aliases. */
	function mockCountsD1(counts: Array<[number, number]>): D1Database {
		const stmt = {
			all: vi.fn().mockResolvedValue({ results: [] }),
			bind: vi.fn().mockReturnThis(),
			first: vi.fn().mockResolvedValue(null),
			raw: vi.fn().mockResolvedValue(counts),
			run: vi.fn().mockResolvedValue({ meta: {}, results: [], success: true }),
		}
		const session = {
			batch: vi.fn(),
			dump: vi.fn(),
			exec: vi.fn(),
			getBookmark: vi.fn().mockReturnValue("bk-test"),
			prepare: vi.fn().mockReturnValue(stmt),
			withSession: vi.fn(),
		}
		return {
			batch: vi.fn(),
			dump: vi.fn(),
			exec: vi.fn(),
			prepare: vi.fn().mockReturnValue(stmt),
			withSession: vi.fn().mockReturnValue(session),
		} as unknown as D1Database
	}

	const deps = (counts: Array<[number, number]> = []) => ({
		coreDb: mockCountsD1(counts),
		kv: mockKV(),
	})

	it("places the first org on shard 0 when every shard is empty", async () => {
		const router = new ShardRouter({ maxOrgsPerShard: 10, totalShards: 4 })
		const { ctx } = mockWaitUntil()

		const mapping = await router.allocate("org-1", deps(), ctx)

		expect(mapping.shardId).toBe(0)
		expect(mapping.target).toBe("0")
		expect(mapping.orgId).toBe("org-1")
		expect(mapping.driver).toBe("d1")
		expect(mapping.deletedAt).toBeNull()
	})

	it("fills the shard with the most headroom, not simply the next one", async () => {
		const router = new ShardRouter({ maxOrgsPerShard: 10, totalShards: 3 })
		const { ctx } = mockWaitUntil()

		/* shard 1 is emptiest */
		const mapping = await router.allocate(
			"org-2",
			deps([
				[9, 0],
				[2, 1],
				[8, 2],
			]),
			ctx,
		)

		expect(mapping.shardId).toBe(1)
	})

	it("refuses to over-fill rather than silently exceeding the cap", async () => {
		const router = new ShardRouter({ maxOrgsPerShard: 2, totalShards: 2 })
		const { ctx } = mockWaitUntil()

		await expect(
			router.allocate(
				"org-3",
				deps([
					[2, 0],
					[2, 1],
				]),
				ctx,
			),
		).rejects.toThrow(/All shards full/)
	})

	it("carries the write bookmark so a following read is not stale", async () => {
		const router = new ShardRouter({ totalShards: 2 })
		const { ctx } = mockWaitUntil()

		const mapping = await router.allocate("org-4", deps(), ctx)
		expect(mapping.d1Bookmark).toBe("bk-test")
	})

	it("primes both cache tiers, deferring the KV write off the request path", async () => {
		const router = new ShardRouter({ totalShards: 2 })
		const { calls, ctx } = mockWaitUntil()
		const d = deps()

		await router.allocate("org-5", d, ctx)

		/* KV write is handed to waitUntil, not awaited inline */
		expect(calls.length).toBeGreaterThan(0)
		await Promise.all(calls)
		expect(d.kv.put).toHaveBeenCalled()

		/* the LRU now answers without touching KV again */
		const putCount = (d.kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls.length
		await router.resolve("org-5", d, ctx)
		expect((d.kv.put as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(putCount)
	})

	it("resolveOrAllocate allocates only when nothing is mapped", async () => {
		const router = new ShardRouter({ totalShards: 2 })
		const { ctx } = mockWaitUntil()

		const first = await router.resolveOrAllocate("org-6", deps(), ctx)
		expect(first.orgId).toBe("org-6")

		/* second call is served from the LRU, so no new allocation */
		const second = await router.resolveOrAllocate("org-6", deps(), ctx)
		expect(second).toEqual(first)
	})

	it("invalidate drops the org from both tiers", async () => {
		const router = new ShardRouter({ totalShards: 2 })
		const { ctx } = mockWaitUntil()
		const d = deps()

		await router.allocate("org-7", d, ctx)
		await router.invalidate("org-7", d.kv)

		expect(d.kv.delete).toHaveBeenCalledWith("shard:org-7")
	})
})
