/**
 * The KV tier of the shard router's cache. KV has no compare-and-set, and a core read from a
 * replica can answer the row from before a remap, so no put can be stopped in time: what a
 * reader trusts is decided instead. An invalidate puts a tombstone carrying a random nonce under
 * its own key, then deletes the mapping's. While the tombstone lives, a mapping counts only when
 * it was tagged with that nonce, which a fill does when it saw the tombstone and so read the
 * primary, after the remap committed; any other is a miss, and the reader reads the primary and
 * puts the mapping tagged. No clock is compared (Q7, C1 of the 0.14.1 review). Mapping and
 * tombstone have separate keys, so a router before 0.14 sharing the KV in a rolling deploy finds a
 * plain miss where an org was invalidated; a tombstone 0.14.0 left in the mapping's key is a miss.
 *
 * Bound: routing converges once the tombstone is visible, within P, KV's propagation to other
 * locations, plus lruTtlMs for an isolate already holding the org in its LRU (never past
 * lruHardTtlMs). A replica still behind the remap more than 3 × kvTtlSeconds after it, once the
 * tombstone has expired, could fill the old shard again; D1's replicas lag by seconds, so that is
 * the outer bound, not a case handled.
 *
 * KV is a cache, so a KV call that fails is logged (`shard-router.kv.error`) and is a skipped
 * write, never a failed request, nor a failed move after its D1 write committed (U34). A read that
 * fails is its own state, never a miss: an unread tombstone may be shadowing the mapping, so the
 * reader trusts nothing KV holds, reads the primary, and leaves KV as it is (Q6 of r17).
 */
import type { LogFn, ShardKv, ShardMapping } from "./types.ts"

/** The KV key of an org's mapping */
const kvKey = (orgId: string): string => `shard:${orgId}`

/** The KV key of the tombstone an invalidate of the org left, under a prefix no mapping key reaches */
const tombstoneKey = (orgId: string): string => `shard-inv:${orgId}`

/**
 * How long a tombstone lives. A location KV has not yet told of it keeps filling from its replica,
 * untagged, until P, KV's propagation bound, taken as kvTtlSeconds' 60 s floor, after the
 * invalidate; each of those puts lives another kvTtlSeconds. So a tombstone must outlive
 * P + kvTtlSeconds, with a margin: 3 × kvTtlSeconds.
 */
const tombstoneTtlSeconds = (kvTtlSeconds: number): number => 3 * kvTtlSeconds

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

/**
 * A mapping as KV holds it: tagged with the nonce of the tombstone its fill read under, if any;
 * a 0.14 fill's `readAt` and an older fill's session bookmark, which no reader is handed
 */
type Stored = ShardMapping & { d1Bookmark?: string; readAt?: number; tag?: string }

/**
 * What KV holds for an org: its mapping and that mapping's tag, or none, and its live tombstone's
 * nonce, if any; or that a read failed, when it says nothing
 */
type KvView =
	| { failed: true }
	| { failed: false; mapping: ShardMapping | null; nonce: string | null; tag: string | null }

/** Marks a KV read that failed, apart from a key that holds nothing */
const FAILED: unique symbol = /* @__PURE__ */ Symbol("kv read failed")

/** What KV holds at `key`, null when it holds nothing; FAILED when the read fails */
const kvGet = <T>(
	kv: ShardKv,
	key: string,
	{ log, orgId }: { log: LogFn; orgId: string },
): Promise<T | null | typeof FAILED> =>
	guarded<T | null | typeof FAILED>(
		{ log, op: "get", orgId },
		async () => (await kv.get(key, "json")) as T | null,
		FAILED,
	)

/** The org's mapping and tombstone in KV, read together; a 0.14.0 tombstone in the mapping's key is no mapping */
async function kvView(kv: ShardKv, orgId: string, log: LogFn): Promise<KvView> {
	const at = { log, orgId }
	const [held, tombstone] = await Promise.all([
		kvGet<Stored | { invalidatedAt: number }>(kv, kvKey(orgId), at),
		kvGet<{ nonce: string }>(kv, tombstoneKey(orgId), at),
	])
	if (held === FAILED || tombstone === FAILED) return { failed: true }
	const nonce = tombstone?.nonce ?? null
	if (held === null || Object.hasOwn(held, "invalidatedAt")) return { failed: false, mapping: null, nonce, tag: null }
	const { d1Bookmark: _bookmark, readAt: _readAt, tag, ...mapping } = held as Stored
	return { failed: false, mapping, nonce, tag: tag ?? null }
}

/** Put the org's tombstone, carrying `nonce`, then delete its mapping: each failure logged */
async function kvInvalidate(
	kv: ShardKv,
	orgId: string,
	{ log, nonce, ttlSeconds }: { log: LogFn; nonce: string; ttlSeconds: number },
): Promise<void> {
	const expirationTtl = tombstoneTtlSeconds(ttlSeconds)
	await guarded(
		{ log, op: "put", orgId },
		() => kv.put(tombstoneKey(orgId), JSON.stringify({ nonce }), { expirationTtl }),
		undefined,
	)
	await guarded({ log, op: "delete", orgId }, () => kv.delete(kvKey(orgId)), undefined)
}

/** Put `mapping` into KV for `ttlSeconds`, tagged with the nonce of the tombstone its read saw, if any; a failure logged */
const kvPut = (
	kv: ShardKv,
	mapping: ShardMapping,
	{ log, tag, ttlSeconds }: { log: LogFn; tag: string | null; ttlSeconds: number },
): Promise<void> =>
	guarded(
		{ log, op: "put", orgId: mapping.orgId },
		() =>
			kv.put(kvKey(mapping.orgId), JSON.stringify(tag === null ? mapping : { ...mapping, tag }), {
				expirationTtl: ttlSeconds,
			}),
		undefined,
	)

export { type KvView, kvInvalidate, kvKey, kvPut, kvView, tombstoneKey, tombstoneTtlSeconds }
