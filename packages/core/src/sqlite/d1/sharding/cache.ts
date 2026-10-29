/**
 * The shard router's cache tiers: this isolate's LRU (stale-while-revalidate), the orgs the primary
 * had no mapping for, and KV (kv-cache.ts). A read that began before an invalidate in this isolate
 * holds the mapping from before it and must not cache it: a generation per org says so. Across
 * isolates, KV's tombstone nonce decides which mapping a reader trusts (Q7, C1 of the 0.14.1 review).
 */
import { LruCache } from "../../../lru.ts"
import { DEFAULTS } from "./config.ts"
import { kvInvalidate, kvPut, kvView, tombstoneTtlSeconds } from "./kv-cache.ts"
import { readLive, readLiveRow } from "./placement.ts"
import type { LogFn, ShardKv, ShardMapping, ShardResolverDeps, ShardRouterConfig, WaitUntilCtx } from "./types.ts"

/** Where a resolved mapping is cached, written off the request path, and the nonce its read was fenced by, if any */
type CacheTargets = { executionCtx: WaitUntilCtx; kv: ShardKv; tag: string | null }

/**
 * What a KV read gives the org: a mapping to trust, or none; and the nonce of a live tombstone,
 * when there is one, which fences the core read: it goes to the primary and tags what it fills
 */
type KvLookup = { fence: string | null; mapping: ShardMapping | null }

class ShardCache {
	readonly lru: LruCache<string, ShardMapping>
	/** Orgs the primary had no mapping for, so a run of requests for an unknown id reads it once */
	readonly misses: LruCache<string, true>
	private readonly kvTtlSeconds: number
	private readonly log: LogFn
	/** Revalidations running now, by org, so concurrent stale hits share one */
	private readonly revalidating = new Map<string, Promise<void>>()
	/** How many times each org was invalidated in this isolate */
	private readonly generations = new Map<string, number>()
	/**
	 * The nonce of this isolate's last tombstone for each org, for as long as the tombstone lives:
	 * this isolate holds it before KV shows the tombstone anywhere, here included
	 */
	private readonly tombstones: LruCache<string, string>

	constructor(config: ShardRouterConfig, { kvTtlSeconds, log }: { kvTtlSeconds: number; log: LogFn }) {
		this.kvTtlSeconds = kvTtlSeconds
		this.log = log
		const maxSize = config.lruMaxSize ?? DEFAULTS.lruMaxSize
		this.lru = new LruCache<string, ShardMapping>({
			hardTtlMs: config.lruHardTtlMs ?? DEFAULTS.lruHardTtlMs,
			maxSize,
			ttlMs: config.lruTtlMs ?? DEFAULTS.lruTtlMs,
		})
		this.misses = new LruCache<string, true>({ maxSize, ttlMs: config.missTtlMs ?? DEFAULTS.missTtlMs })
		this.tombstones = new LruCache<string, string>({ maxSize, ttlMs: tombstoneTtlSeconds(kvTtlSeconds) * 1000 })
	}

	/**
	 * The org's mapping in KV when it may be trusted: with no live tombstone, here or in KV, any is;
	 * with one, only a mapping tagged with its nonce, and with two that differ, none. The fence is
	 * KV's nonce, else this isolate's
	 */
	async readKv(orgId: string, kv: ShardKv): Promise<KvLookup> {
		const view = await kvView(kv, orgId, this.log)
		const live = new Set([view.nonce, this.tombstones.get(orgId) ?? null].filter((n) => n !== null))
		const fence = view.nonce ?? this.tombstones.get(orgId) ?? null
		const trusted = live.size === 0 || (live.size === 1 && view.tag === fence)
		return { fence, mapping: trusted ? view.mapping : null }
	}

	/** The org's live mapping in the core database: the primary's when a tombstone fences the read, else as readLive reads it */
	static async readCore(
		coreDb: ShardResolverDeps["coreDb"],
		orgId: string,
		fence: string | null,
	): Promise<ShardMapping | undefined> {
		return fence === null ? readLive(coreDb, orgId) : (await readLiveRow(coreDb, orgId, "first-primary")).mapping
	}

	generationOf(orgId: string): number {
		return this.generations.get(orgId) ?? 0
	}

	populate(orgId: string, mapping: ShardMapping, { executionCtx, kv, tag }: CacheTargets): void {
		this.lru.set(orgId, mapping)
		executionCtx.waitUntil(kvPut(kv, mapping, { log: this.log, tag, ttlSeconds: this.kvTtlSeconds }))
	}

	/**
	 * Forget the org in this isolate's tiers and in KV, leaving a tombstone; another isolate's LRU
	 * keeps it until it expires. Returns the tombstone's nonce, for a mapping read after the remap
	 */
	async invalidate(orgId: string, kv: ShardKv): Promise<string> {
		const nonce = crypto.randomUUID()
		this.generations.set(orgId, this.generationOf(orgId) + 1)
		this.lru.delete(orgId)
		this.misses.delete(orgId)
		this.tombstones.set(orgId, nonce)
		await kvInvalidate(kv, orgId, { log: this.log, nonce, ttlSeconds: this.kvTtlSeconds })
		return nonce
	}

	/** One background revalidation per org at a time, however many requests see it stale */
	revalidateOnce(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): void {
		if (this.revalidating.has(orgId)) return
		const running = this.revalidate(orgId, deps).finally(() => this.revalidating.delete(orgId))
		this.revalidating.set(orgId, running)
		executionCtx.waitUntil(running)
	}

	/** Background SWR revalidation — refreshes LRU from KV or Core D1 */
	private async revalidate(orgId: string, deps: ShardResolverDeps): Promise<void> {
		const generation = this.generationOf(orgId)
		const current = () => this.generationOf(orgId) === generation
		try {
			const { fence, mapping: kvValue } = await this.readKv(orgId, deps.kv)
			/* readKv takes this isolate's tombstones after its KV read, so an invalidate here during it is a miss */
			if (kvValue) {
				this.lru.set(orgId, kvValue)
				return
			}
			const mapping = await ShardCache.readCore(deps.coreDb, orgId, fence)
			if (!current()) return
			if (!mapping) {
				/* the core database has no live row: the org is gone, so the stale entry stops routing it now */
				await this.invalidate(orgId, deps.kv)
				return
			}
			this.lru.set(orgId, mapping)
			await kvPut(deps.kv, mapping, { log: this.log, tag: fence, ttlSeconds: this.kvTtlSeconds })
		} catch (e) {
			this.log("shard-router.revalidate.error", { error: e, orgId })
		}
	}
}

export { type CacheTargets, ShardCache }
