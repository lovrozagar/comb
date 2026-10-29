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
		cache.populate("org-1", mapping(1, 10), { executionCtx: ctx, kv, tag: null })
		await settle()
		expect(cache.lru.getWithMeta("org-1")?.value.shardId).toBe(1)
		expect((JSON.parse(kv.store.get("shard:org-1") as string) as ShardMapping).shardId).toBe(1)
		cache.misses.set("org-1", true)
		const nonce = await cache.invalidate("org-1", kv)
		expect([cache.lru.getWithMeta("org-1"), cache.misses.get("org-1")]).toEqual([undefined, undefined])
		expect(kv.store.has("shard:org-1")).toBe(false)
		expect(JSON.parse(kv.store.get("shard-inv:org-1") as string)).toEqual({ nonce })
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

	/* a fill that read before this isolate's invalidate lands after it, while KV shows the tombstone nowhere yet */
	it("distrusts here a fill that lands over its own invalidate before KV shows the tombstone", async () => {
		const [cache, store] = [cacheOf(), memoryKv()]
		const kv: ShardKv = {
			...store,
			put: async (key, value) => void (key.startsWith("shard:") && store.put(key, value)),
		}
		const nonce = await cache.invalidate("org-1", kv)
		store.store.set("shard:org-1", JSON.stringify(mapping(0, 10)))
		expect(await cache.readKv("org-1", store)).toEqual({ fence: nonce, mapping: null })
	})
})

/* Q7, C1 of the 0.14.1 review: which KV mapping a reader trusts, by the tombstone's nonce and no clock */
/** KV holding org-1's tombstone, carrying `nonce` */
const tombstone = (kv: ReturnType<typeof memoryKv>, nonce: string) =>
	kv.store.set("shard-inv:org-1", JSON.stringify({ nonce }))

/** KV holding org-1's mapping, tagged with `tag` when one is given */
const held = (kv: ReturnType<typeof memoryKv>, tag?: string) =>
	kv.store.set("shard:org-1", JSON.stringify({ ...mapping(1, 10), ...(tag === undefined ? {} : { tag }) }))

describe("ShardCache.readKv", () => {
	it("trusts any mapping with no tombstone, a 0.14 fill's readAt left out", async () => {
		const [cache, kv] = [cacheOf(), memoryKv()]
		kv.store.set("shard:org-1", JSON.stringify({ ...mapping(1, 10), readAt: 5 }))
		expect(await cache.readKv("org-1", kv)).toEqual({ fence: null, mapping: mapping(1, 10) })
	})

	it("trusts, while a tombstone lives, only a mapping tagged with its nonce", async () => {
		const [cache, kv] = [cacheOf(), memoryKv()]
		tombstone(kv, "n-1")
		held(kv)
		expect(await cache.readKv("org-1", kv)).toEqual({ fence: "n-1", mapping: null })
		held(kv, "n-0")
		expect(await cache.readKv("org-1", kv)).toEqual({ fence: "n-1", mapping: null })
		held(kv, "n-1")
		expect(await cache.readKv("org-1", kv)).toEqual({ fence: "n-1", mapping: mapping(1, 10) })
	})

	it("trusts none while this isolate's tombstone and KV's differ, fencing by KV's", async () => {
		const [cache, kv] = [cacheOf(), memoryKv()]
		const mine = await cache.invalidate("org-1", kv)
		held(kv, mine)
		expect(await cache.readKv("org-1", kv)).toEqual({ fence: mine, mapping: mapping(1, 10) })
		tombstone(kv, "n-other")
		expect(await cache.readKv("org-1", kv)).toEqual({ fence: "n-other", mapping: null })
	})

	it("is no mapping where 0.14.0 left its tombstone in the mapping's key", async () => {
		const [cache, kv] = [cacheOf(), memoryKv()]
		kv.store.set("shard:org-1", JSON.stringify({ invalidatedAt: 5000 }))
		expect(await cache.readKv("org-1", kv)).toEqual({ fence: null, mapping: null })
	})
})
