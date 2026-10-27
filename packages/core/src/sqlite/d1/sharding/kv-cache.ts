/**
 * The KV tier of the shard router's cache. A read that began before a `move` in another isolate
 * holds the old row; KV keeps a mapping's `updatedAt`, so a put of a row older than the one KV
 * holds is skipped, and the old mapping is not written back over the moved one (U33). KV has no
 * compare-and-set, so a newer put landing between this read and this put can still be overwritten,
 * and an isolate may serve the old shard for kvTtlSeconds + lruTtlMs + one revalidation at most.
 * KV is a cache, so a KV call that fails is logged (`shard-router.kv.error`) and is a miss or a
 * skipped write, never a failed request, nor a failed move after its D1 write committed (U34).
 */
import type { LogFn, ShardKv, ShardMapping } from "./types.ts"

/** The KV key of an org's mapping */
const kvKey = (orgId: string): string => `shard:${orgId}`

/** Run one KV call; a failure is logged and answers `fallback` */
async function guarded<T>(
	{ log, op, orgId }: { log: LogFn; op: string; orgId: string },
	call: () => Promise<T>,
	fallback: T,
): Promise<T> {
	try {
		return await call()
	} catch (error) {
		// reason: KV is a cache: a failed call is a miss or a skipped write, logged, never a failed request
		log("shard-router.kv.error", { error, op, orgId })
		return fallback
	}
}

/** The org's mapping in KV; null when KV holds none, or fails */
const kvRead = (kv: ShardKv, orgId: string, log: LogFn): Promise<ShardMapping | null> =>
	guarded({ log, op: "get", orgId }, async () => (await kv.get(kvKey(orgId), "json")) as ShardMapping | null, null)

/** Delete the org's mapping from KV, a failure logged */
const kvDelete = (kv: ShardKv, orgId: string, log: LogFn): Promise<void> =>
	guarded({ log, op: "delete", orgId }, () => kv.delete(kvKey(orgId)), undefined)

/** Put `mapping` into KV for `ttlSeconds`, unless KV holds a mapping of the org updated after it; a failure logged */
async function putUnlessNewer(
	kv: ShardKv,
	mapping: ShardMapping,
	{ log, ttlSeconds }: { log: LogFn; ttlSeconds: number },
): Promise<void> {
	const held = await kvRead(kv, mapping.orgId, log)
	if (held !== null && held.updatedAt > mapping.updatedAt) return
	await guarded(
		{ log, op: "put", orgId: mapping.orgId },
		() => kv.put(kvKey(mapping.orgId), JSON.stringify(mapping), { expirationTtl: ttlSeconds }),
		undefined,
	)
}

export { kvDelete, kvKey, kvRead, putUnlessNewer }
