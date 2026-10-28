import type { D1Database } from "@cloudflare/workers-types"
import { describe, expect, it } from "vitest"
import { ShardCache } from "./cache.ts"
import type { ShardKv, ShardMapping } from "./types.ts"

/** A KV that keeps what it is given, and the keys it was asked for */
function memoryKv(): ShardKv & { store: Map<string, string> } {
	const store = new Map<string, string>()
	return {
		delete: async (key) => void store.delete(key),
		get: async (key) => (store.has(key) ? JSON.parse(store.get(key) as string) : null),
		put: async (key, value) => void store.set(key, value),
		store,
	}
}

const mapping = (shardId: number, updatedAt: number): ShardMapping => ({
	createdAt: 0,
	deletedAt: null,
	driver: "d1",
	orgId: "org-1",
	shardId,
	target: String(shardId),
	updatedAt,
})

/** A waitUntil that keeps each promise, to await them all */
function context() {
	const pending: Promise<unknown>[] = []
	return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) }
}

const cacheOf = () => new ShardCache({ totalShards: 3 }, { kvTtlSeconds: 60, log: () => undefined })

describe("ShardCache", () => {
	it("fills this isolate's LRU and KV, and forgets both on invalidate, counting the generation", async () => {
		const [cache, kv, { ctx, settle }] = [cacheOf(), memoryKv(), context()]
		cache.populate("org-1", mapping(1, 10), { executionCtx: ctx, kv, readAt: Date.now() })
		await settle()
		expect(cache.lru.getWithMeta("org-1")?.value.shardId).toBe(1)
		expect((JSON.parse(kv.store.get("shard:org-1") as string) as ShardMapping).shardId).toBe(1)
		cache.misses.set("org-1", true)
		await cache.invalidate("org-1", kv)
		expect([cache.lru.getWithMeta("org-1"), cache.misses.get("org-1")]).toEqual([undefined, undefined])
		expect(JSON.parse(kv.store.get("shard:org-1") as string)).toEqual({ invalidatedAt: expect.any(Number) })
		expect(cache.generationOf("org-1")).toBe(1)
	})

	it("revalidates an org once however many ask, from KV when KV holds it", async () => {
		const [cache, kv, { ctx, settle }] = [cacheOf(), memoryKv(), context()]
		kv.store.set("shard:org-1", JSON.stringify(mapping(2, 20)))
		const deps = { coreDb: {} as D1Database, kv }
		cache.revalidateOnce("org-1", deps, ctx)
		cache.revalidateOnce("org-1", deps, ctx)
		await settle()
		expect(cache.lru.getWithMeta("org-1")?.value.shardId).toBe(2)
	})
})
