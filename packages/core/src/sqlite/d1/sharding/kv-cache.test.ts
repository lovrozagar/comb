import { describe, expect, it } from "vitest"
import { kvInvalidate, kvKey, kvPut, kvView, tombstoneKey, tombstoneTtlSeconds } from "./kv-cache.ts"
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

const mapping = (shardId: number, updatedAt: number): ShardMapping => ({
	createdAt: 1000,
	deletedAt: null,
	driver: "d1",
	orgId: "org-1",
	shardId,
	target: String(shardId),
	updatedAt,
})

const log = () => undefined

describe("kvPut", () => {
	it("puts a mapping untagged with no fence, and tagged with its fence's nonce, for the KV TTL", async () => {
		const kv = memoryKV()
		const ttls: Array<number | undefined> = []
		const watched: ShardKv = {
			...kv,
			put: async (key, value, opts) => (ttls.push(opts?.expirationTtl), kv.put(key, value)),
		}
		await kvPut(watched, mapping(1, 1000), { log, tag: null, ttlSeconds: 60 })
		expect(JSON.parse(kv.values.get(kvKey("org-1")) as string)).toEqual(mapping(1, 1000))
		await kvPut(watched, mapping(1, 1000), { log, tag: "n-1", ttlSeconds: 60 })
		expect(JSON.parse(kv.values.get(kvKey("org-1")) as string)).toEqual({ ...mapping(1, 1000), tag: "n-1" })
		expect(ttls).toEqual([60, 60])
	})
})

describe("kvInvalidate", () => {
	it("puts the tombstone, then deletes the mapping, the tombstone kept for 3 × the KV TTL", async () => {
		const kv = memoryKV()
		const ops: string[] = []
		const watched: ShardKv = {
			delete: async (key) => (ops.push(`delete ${key}`), kv.delete(key)),
			get: kv.get,
			put: async (key, value, opts) => (ops.push(`put ${key} ${opts?.expirationTtl}`), kv.put(key, value)),
		}
		await kv.put(kvKey("org-1"), JSON.stringify(mapping(1, 1000)))
		await kvInvalidate(watched, "org-1", { log, nonce: "n-1", ttlSeconds: 60 })
		expect(ops).toEqual(["put shard-inv:org-1 180", "delete shard:org-1"])
		expect(tombstoneTtlSeconds(60)).toBe(180)
		expect(await kvView(kv, "org-1", log)).toEqual({ mapping: null, nonce: "n-1", tag: null })
	})
})

/* G3 of plan 14: a router on 0.13.x reading the same KV in a rolling deploy sees an invalidation as a plain miss */
describe("an invalidation, as a 0.13 router reads KV", () => {
	it("leaves the mapping key empty, the tombstone under its own key", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify(mapping(1, 1000)))
		await kvInvalidate(kv, "org-1", { log, nonce: "n-1", ttlSeconds: 60 })
		/* 0.13.1 parses the mapping key as a mapping: after an invalidate it must find nothing there */
		expect(kv.values.has(kvKey("org-1"))).toBe(false)
		expect(JSON.parse(kv.values.get("shard-inv:org-1") as string)).toEqual({ nonce: "n-1" })
	})

	it("is no mapping where 0.14.0 left its tombstone in the mapping key", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify({ invalidatedAt: 5000 }))
		expect(await kvView(kv, "org-1", log)).toEqual({ mapping: null, nonce: null, tag: null })
	})
})

/* Q9 of the 0.14.1 review: an org's tombstone key lies where no org's mapping key can reach */
describe("an org whose id ends in :inv", () => {
	it("is no tombstone of another org, nor is the key 0.14.1 left one", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify(mapping(1, 1000)))
		await kv.put(kvKey("org-1:inv"), JSON.stringify({ ...mapping(3, 9000), orgId: "org-1:inv" }))
		expect(tombstoneKey("org-1")).not.toBe(kvKey("org-1:inv"))
		expect(await kvView(kv, "org-1", log)).toEqual({ mapping: mapping(1, 1000), nonce: null, tag: null })
	})
})
