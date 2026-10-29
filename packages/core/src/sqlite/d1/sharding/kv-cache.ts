/**
 * The KV tier of the shard router's cache. A read that began before a `move` in another isolate
 * holds the old row; KV keeps a mapping's `updatedAt`, so a put of a row older than the one KV
 * holds is skipped, and the old mapping is not written back over the moved one (U33). An invalidate
 * leaves a tombstone for the TTL, `{ invalidatedAt }`, so a fill that read the core table before it,
 * and reaches KV after it, finds it and writes nothing; one that read the core table after it lands
 * (G2 of plan 14). The tombstone has its own key and the invalidate deletes the mapping's, so a read,
 * and a router before 0.14 sharing the KV in a rolling deploy, find a plain miss there; one 0.14.0
 * left in the mapping's key is a miss too (G3 of plan 14). KV has no
 * compare-and-set, so a newer put landing between this read and this put can still be overwritten,
 * and an isolate may serve the old shard for kvTtlSeconds + lruTtlMs + one revalidation at most.
 * KV is a cache, so a KV call that fails is logged (`shard-router.kv.error`) and is a miss or a
 * skipped write, never a failed request, nor a failed move after its D1 write committed (U34).
 */
import type { LogFn, ShardKv, ShardMapping } from "./types.ts"

/** The KV key of an org's mapping */
const kvKey = (orgId: string): string => `shard:${orgId}`

/** The KV key of the tombstone an invalidate of the org left, under a prefix no mapping key reaches */
const tombstoneKey = (orgId: string): string => `shard-inv:${orgId}`

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

/** A mapping as KV holds it, with when the fill that wrote it read the core table; none before 0.14 */
type Stored = ShardMapping & { readAt?: number }

/** What KV holds for an org: its mapping, or the tombstone an invalidate left */
type Held = Stored | { invalidatedAt: number }

const isTombstone = (held: Held): held is { invalidatedAt: number } => Object.hasOwn(held, "invalidatedAt")

/** What KV holds at `key`; null when it holds nothing, or fails */
const kvHeld = (kv: ShardKv, key: string, { log, orgId }: { log: LogFn; orgId: string }): Promise<Held | null> =>
	guarded({ log, op: "get", orgId }, async () => (await kv.get(key, "json")) as Held | null, null)

/**
 * The org's mapping in KV, and when the fill that wrote it read the core table (-Infinity for one a
 * fill before 0.14 wrote, which said not); null when KV holds none, holds its tombstone, or fails
 */
async function kvRead(
	kv: ShardKv,
	orgId: string,
	log: LogFn,
): Promise<{ mapping: ShardMapping; readAt: number } | null> {
	const held = await kvHeld(kv, kvKey(orgId), { log, orgId })
	if (held === null || isTombstone(held)) return null
	const { readAt, ...mapping } = held
	return { mapping, readAt: readAt ?? Number.NEGATIVE_INFINITY }
}

/**
 * Leave the org's tombstone in KV for `ttlSeconds`, then delete its mapping: in that order, so no
 * fill that reads the mapping's key after the delete misses the tombstone. Each failure logged
 */
async function kvInvalidate(
	kv: ShardKv,
	orgId: string,
	{ log, ttlSeconds }: { log: LogFn; ttlSeconds: number },
): Promise<void> {
	await guarded(
		{ log, op: "put", orgId },
		() => kv.put(tombstoneKey(orgId), JSON.stringify({ invalidatedAt: Date.now() }), { expirationTtl: ttlSeconds }),
		undefined,
	)
	await guarded({ log, op: "delete", orgId }, () => kv.delete(kvKey(orgId)), undefined)
}

/** Whether what KV holds at a key stops a put of `mapping` read at `readAt` */
const stops = (held: Held | null, mapping: ShardMapping, readAt: number): boolean =>
	held !== null && (isTombstone(held) ? held.invalidatedAt >= readAt : held.updatedAt > mapping.updatedAt)

/**
 * Put `mapping`, read from the core table at `readAt`, into KV for `ttlSeconds`, unless KV holds a
 * mapping of the org updated after it, or a tombstone an invalidate left at or after `readAt`, under
 * its own key or, as 0.14.0 wrote it, the mapping's. The mapping's key is read first: an invalidate
 * puts its tombstone before it deletes the mapping, so a fill that reads the key after the delete
 * finds the tombstone. A
 * read in the invalidation's own millisecond cannot be ordered against it, so it is skipped, which
 * costs one more core read where a put could route to the old shard for the TTL. `current` says
 * whether this isolate has not invalidated the org since the fill began: it is asked after the KV
 * read and right before the put is issued, with no await between, so an invalidate here that wrote
 * its tombstone after that read is not put over. A failure logged.
 */
async function putUnlessNewer(
	kv: ShardKv,
	mapping: ShardMapping,
	{ current, log, readAt, ttlSeconds }: { current: () => boolean; log: LogFn; readAt: number; ttlSeconds: number },
): Promise<void> {
	const at = { log, orgId: mapping.orgId }
	if (stops(await kvHeld(kv, kvKey(mapping.orgId), at), mapping, readAt)) return
	if (stops(await kvHeld(kv, tombstoneKey(mapping.orgId), at), mapping, readAt)) return
	if (!current()) return
	await guarded(
		{ log, op: "put", orgId: mapping.orgId },
		() => kv.put(kvKey(mapping.orgId), JSON.stringify({ ...mapping, readAt }), { expirationTtl: ttlSeconds }),
		undefined,
	)
}

export { kvInvalidate, kvKey, kvRead, putUnlessNewer }
