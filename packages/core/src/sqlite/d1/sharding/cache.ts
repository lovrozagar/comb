/**
 * The shard router's cache tiers: this isolate's LRU (stale-while-revalidate), the orgs the primary
 * had no mapping for, and KV (kv-cache.ts). A read that began before an invalidate holds the mapping
 * from before it and must not write it back: in this isolate a generation per org says so, and
 * across isolates KV keeps the newest mapping by its updatedAt (U33).
 */
import { LruCache } from "../../../lru.ts"
import { DEFAULTS } from "./config.ts"
import { kvInvalidate, kvRead, putUnlessNewer } from "./kv-cache.ts"
import { readLive } from "./placement.ts"
import type { LogFn, ShardKv, ShardMapping, ShardResolverDeps, ShardRouterConfig, WaitUntilCtx } from "./types.ts"

/** Where a resolved mapping is cached, written off the request path, and when its core read began */
type CacheTargets = { executionCtx: WaitUntilCtx; kv: ShardKv; readAt: number }

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
	 * When this isolate last invalidated each org, for the KV TTL: a KV entry a fill in any isolate
	 * read from the core table at or before then is a miss here, as KV has no compare-and-set to stop
	 * another isolate's fill landing over the invalidation
	 */
	private readonly invalidated: LruCache<string, number>

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
		this.invalidated = new LruCache<string, number>({ maxSize, ttlMs: kvTtlSeconds * 1000 })
	}

	/** The org's mapping in KV, unless a fill read it from the core table at or before this isolate last invalidated it */
	async readKv(orgId: string, kv: ShardKv): Promise<ShardMapping | null> {
		const held = await kvRead(kv, orgId, this.log)
		if (held === null) return null
		const invalidatedAt = this.invalidated.get(orgId)
		return invalidatedAt !== undefined && held.readAt <= invalidatedAt ? null : held.mapping
	}

	generationOf(orgId: string): number {
		return this.generations.get(orgId) ?? 0
	}

	populate(orgId: string, mapping: ShardMapping, { executionCtx, kv, readAt }: CacheTargets): void {
		this.lru.set(orgId, mapping)
		const generation = this.generationOf(orgId)
		const current = () => this.generationOf(orgId) === generation
		/* a read that began before a move or an invalidate, here or elsewhere, does not overwrite what it left (U33) */
		executionCtx.waitUntil(
			putUnlessNewer(kv, mapping, { current, log: this.log, readAt, ttlSeconds: this.kvTtlSeconds }),
		)
	}

	/** Forget the org in this isolate's tiers and in KV; another isolate's LRU keeps it until it expires */
	async invalidate(orgId: string, kv: ShardKv): Promise<void> {
		this.generations.set(orgId, this.generationOf(orgId) + 1)
		this.lru.delete(orgId)
		this.misses.delete(orgId)
		this.invalidated.set(orgId, Date.now())
		await kvInvalidate(kv, orgId, { log: this.log, ttlSeconds: this.kvTtlSeconds })
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
			/* readKv answers only a mapping read from the core table after every invalidate here, one during its read included */
			const kvValue = await this.readKv(orgId, deps.kv)
			if (kvValue) {
				this.lru.set(orgId, kvValue)
				return
			}
			const readAt = Date.now()
			const mapping = await readLive(deps.coreDb, orgId)
			if (!current()) return
			if (!mapping) {
				/* the core database has no live row: the org is gone, so the stale entry stops routing it now */
				this.lru.delete(orgId)
				await kvInvalidate(deps.kv, orgId, { log: this.log, ttlSeconds: this.kvTtlSeconds })
				return
			}
			this.lru.set(orgId, mapping)
			await putUnlessNewer(deps.kv, mapping, { current, log: this.log, readAt, ttlSeconds: this.kvTtlSeconds })
		} catch (e) {
			this.log("shard-router.revalidate.error", { error: e, orgId })
		}
	}
}

export { type CacheTargets, ShardCache }
