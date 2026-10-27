import { describe, expect, it } from "vitest"
import { kvKey, putUnlessNewer } from "./kv-cache.ts"
import { ShardRouter } from "./router.ts"
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
		await putUnlessNewer(kv, mapping(2, 2000), { log: () => {}, ttlSeconds: 60 })
		await putUnlessNewer(kv, mapping(1, 1000), { log: () => {}, ttlSeconds: 60 })
		expect(shardIn(kv)).toBe(2)
		await putUnlessNewer(kv, mapping(3, 2000), { log: () => {}, ttlSeconds: 60 })
		expect(shardIn(kv)).toBe(3)
		await putUnlessNewer(kv, mapping(4, 3000), { log: () => {}, ttlSeconds: 60 })
		expect(shardIn(kv)).toBe(4)
	})

	it("keeps the moved mapping in KV when an isolate's old read caches what it read", async () => {
		const kv = memoryKV()
		await kv.put(kvKey("org-1"), JSON.stringify(mapping(2, 2000)))
		const waits: Promise<unknown>[] = []
		const router = new ShardRouter({ totalShards: 4 })
		const stale = mapping(1, 1000)
		/* the old row, as a core read that began before the move returns it */
		const populate = (router as unknown as { populateCaches: (...args: unknown[]) => void }).populateCaches
		populate.call(router, "org-1", stale, { executionCtx: { waitUntil: (p: Promise<unknown>) => waits.push(p) }, kv })
		await Promise.all(waits)
		expect(shardIn(kv)).toBe(2)
	})
})
