/**
 * The KV tier of the shard router's cache. A read that began before a `move` in another isolate
 * holds the old row; KV keeps a mapping's `updatedAt`, so a put of a row older than the one KV
 * holds is skipped, and the old mapping is not written back over the moved one (U33). KV has no
 * compare-and-set, so a newer put landing between this read and this put can still be overwritten,
 * and an isolate may serve the old shard for kvTtlSeconds + lruTtlMs + one revalidation at most.
 */
import type { ShardKv, ShardMapping } from "./types.ts"

/** The KV key of an org's mapping */
const kvKey = (orgId: string): string => `shard:${orgId}`

/** Put `mapping` into KV for `ttlSeconds`, unless KV holds a mapping of the org updated after it */
async function putUnlessNewer(kv: ShardKv, mapping: ShardMapping, ttlSeconds: number): Promise<void> {
	const held = (await kv.get(kvKey(mapping.orgId), "json")) as ShardMapping | null
	if (held !== null && held.updatedAt > mapping.updatedAt) return
	await kv.put(kvKey(mapping.orgId), JSON.stringify(mapping), { expirationTtl: ttlSeconds })
}

export { kvKey, putUnlessNewer }
