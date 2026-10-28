/**
 * The KV tier of the shard router's cache. A read that began before a `move` in another isolate
 * holds the old row; KV keeps a mapping's `updatedAt`, so a put of a row older than the one KV
 * holds is skipped, and the old mapping is not written back over the moved one (U33). An invalidate
 * leaves a tombstone for the TTL, `{ invalidatedAt }`, where it deleted the key, so a fill that read
 * the core table before it, and reaches KV after it, finds it and writes nothing; one that read the
 * core table after it lands, and a read takes the tombstone as a miss (G2 of plan 14). KV has no
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

/** What KV holds for an org: its mapping, or the tombstone an invalidate left */
type Held = ShardMapping | { invalidatedAt: number }

const isTombstone = (held: Held): held is { invalidatedAt: number } => Object.hasOwn(held, "invalidatedAt")

/** What KV holds for the org; null when it holds nothing, or fails */
const kvHeld = (kv: ShardKv, orgId: string, log: LogFn): Promise<Held | null> =>
	guarded({ log, op: "get", orgId }, async () => (await kv.get(kvKey(orgId), "json")) as Held | null, null)

/** The org's mapping in KV; null when KV holds none, holds its tombstone, or fails */
async function kvRead(kv: ShardKv, orgId: string, log: LogFn): Promise<ShardMapping | null> {
	const held = await kvHeld(kv, orgId, log)
	return held === null || isTombstone(held) ? null : held
}

/** Leave the org's tombstone in KV for `ttlSeconds`, a failure logged */
const kvInvalidate = (
	kv: ShardKv,
	orgId: string,
	{ log, ttlSeconds }: { log: LogFn; ttlSeconds: number },
): Promise<void> =>
	guarded(
		{ log, op: "put", orgId },
		() => kv.put(kvKey(orgId), JSON.stringify({ invalidatedAt: Date.now() }), { expirationTtl: ttlSeconds }),
		undefined,
	)

/**
 * Put `mapping`, read from the core table at `readAt`, into KV for `ttlSeconds`, unless KV holds a
 * mapping of the org updated after it, or a tombstone an invalidate left at or after `readAt`: a
 * read in the invalidation's own millisecond cannot be ordered against it, so it is skipped, which
 * costs one more core read where a put could route to the old shard for the TTL. A failure logged.
 */
async function putUnlessNewer(
	kv: ShardKv,
	mapping: ShardMapping,
	{ log, readAt, ttlSeconds }: { log: LogFn; readAt: number; ttlSeconds: number },
): Promise<void> {
	const held = await kvHeld(kv, mapping.orgId, log)
	if (held !== null && (isTombstone(held) ? held.invalidatedAt >= readAt : held.updatedAt > mapping.updatedAt)) return
	await guarded(
		{ log, op: "put", orgId: mapping.orgId },
		() => kv.put(kvKey(mapping.orgId), JSON.stringify(mapping), { expirationTtl: ttlSeconds }),
		undefined,
	)
}

export { kvInvalidate, kvKey, kvRead, putUnlessNewer }
