import { describe, expect, it } from "vitest"
import { kvInvalidate, kvKey, kvRead, putUnlessNewer } from "./kv-cache.ts"
import { ShardCache } from "./cache.ts"
import type { ShardKv, ShardMapping } from "./types.ts"

/** A KV namespace over a map, its values as KV stores them: JSON text */
function memoryKV(): ShardKv & { values: Map<string, string> } {
	const values = new Map<string, string>()
	return {
		delete: async (key: string) => void values.delete(key),
		get: async (key: string) => {
			const value = values.get(key)
			return value === undefined ? null : JSON.parse(value)
		},
		put: async (key: string, value: string) => void values.set(key, value),
		values,
	}
}

/** The shard KV maps org-1 to */
const shardIn = (kv: ReturnType<typeof memoryKV>): number =>
	(JSON.parse(kv.values.get(kvKey("org-1")) as string) as ShardMapping).shardId

const mapping = (shardId: number, updatedAt: number): ShardMapping => ({
	createdAt: 1000,
	deletedAt: null,
	driver: "d1",
	orgId: "org-1",
	shardId,
	target: String(shardId),
	updatedAt,
})

/* U33: a read in flight across another isolate's move holds the old row, and must not write it back */
describe("putUnlessNewer", () => {
	it("skips a mapping older than the one KV holds, and puts a newer or an equal one", async () => {
		const kv = memoryKV()
		await putUnlessNewer(kv, mapping(2, 2000), { current: () => true, log: () => {}, readAt: 0, ttlSeconds: 60 })
		await putUnlessNewer(kv, mapping(1, 1000), { current: () => true, log: () => {}, readAt: 0, ttlSeconds: 60 })
		expect(shardIn(kv)).toBe(2)
		await putUnlessNewer(kv, mapping(3, 2000), { current: () => true, log: () => {}, readAt: 0, ttlSeconds: 60 })
		expect(shardIn(kv)).toBe(3)
		await putUnlessNewer(kv, mapping(4, 3000), { current: () => true, log: () => {}, readAt: 0, ttlSeconds: 60 })
		expect(shardIn(kv)).toBe(4)
	})

	it("keeps the moved mapping in KV when an isolate's old read caches what it read", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify(mapping(2, 2000)))
		const waits: Promise<unknown>[] = []
		const cache = new ShardCache({ totalShards: 4 }, { kvTtlSeconds: 60, log: () => undefined })
		/* the old row, as a core read that began before the move returns it */
		cache.populate("org-1", mapping(1, 1000), {
			executionCtx: { waitUntil: (p: Promise<unknown>) => waits.push(p) },
			kv,
			readAt: 0,
		})
		await Promise.all(waits)
		expect(shardIn(kv)).toBe(2)
	})
})

/* G2 of plan 14 (U33): an invalidate leaves a tombstone, which a fill that read D1 before it does not overwrite */
describe("an invalidation in KV", () => {
	const options = { current: () => true, log: () => undefined, readAt: 0, ttlSeconds: 60 }

	it("is a tombstone kvRead answers as a miss, kept for the TTL", async () => {
		const kv = memoryKV()
		const puts: Array<{ ttl: number | undefined }> = []
		const watched = {
			...kv,
			put: async (key: string, value: string, opts?: { expirationTtl?: number }) => (
				puts.push({ ttl: opts?.expirationTtl }),
				kv.put(key, value)
			),
		}
		await kv.put(kvKey("org-1"), JSON.stringify(mapping(1, 1000)))
		await kvInvalidate(watched, "org-1", options)
		expect(JSON.parse(kv.values.get("shard-inv:org-1") as string)).toEqual({ invalidatedAt: expect.any(Number) })
		expect(puts).toEqual([{ ttl: 60 }])
		expect(await kvRead(kv, "org-1", options.log)).toBeNull()
	})

	/* the tombstone where 0.14.0 left it, in the mapping's key */
	it("stops a fill that read the core table before it, and takes one that read it after", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify({ invalidatedAt: 5000 }))
		await putUnlessNewer(kv, mapping(1, 1000), { ...options, readAt: 4999 })
		await putUnlessNewer(kv, mapping(1, 1000), { ...options, readAt: 5000 })
		expect(JSON.parse(kv.values.get(kvKey("org-1")) as string)).toEqual({ invalidatedAt: 5000 })
		await putUnlessNewer(kv, mapping(2, 6000), { ...options, readAt: 5001 })
		expect(shardIn(kv)).toBe(2)
	})
})

/* G3 of plan 14: a router on 0.13.x reading the same KV in a rolling deploy sees an invalidation as a plain miss */
describe("an invalidation, as a 0.13 router reads KV", () => {
	const options = { current: () => true, log: () => undefined, readAt: 0, ttlSeconds: 60 }

	it("leaves the mapping key empty, its tombstone apart, and still stops a fill that read before it", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify(mapping(1, 1000)))
		await kvInvalidate(kv, "org-1", options)
		/* 0.13.1 parses the mapping key as a mapping: after an invalidate it must find nothing there */
		expect(kv.values.has(kvKey("org-1"))).toBe(false)
		expect(JSON.parse(kv.values.get("shard-inv:org-1") as string)).toEqual({ invalidatedAt: expect.any(Number) })
		await putUnlessNewer(kv, mapping(1, 1000), { ...options, readAt: 0 })
		expect(kv.values.has(kvKey("org-1"))).toBe(false)
		await putUnlessNewer(kv, mapping(2, 2000), { ...options, readAt: Date.now() + 1 })
		expect(shardIn(kv)).toBe(2)
	})

	it("is a miss where 0.14.0 left its tombstone in the mapping key", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify({ invalidatedAt: 5000 }))
		expect(await kvRead(kv, "org-1", options.log)).toBeNull()
	})
})

/* Q9 of the 0.14.1 review: an org's tombstone key lies where no org's mapping key can reach */
describe("an org whose id ends in :inv", () => {
	const options = { current: () => true, log: () => undefined, readAt: 0, ttlSeconds: 60 }

	it("does not stop another org's fill through its own mapping", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1:inv"), JSON.stringify({ ...mapping(3, 9000), orgId: "org-1:inv" }))
		await putUnlessNewer(kv, mapping(1, 1000), options)
		expect(shardIn(kv)).toBe(1)
	})
})
