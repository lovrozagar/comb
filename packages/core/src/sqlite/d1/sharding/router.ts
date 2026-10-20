import type { D1Database } from "@cloudflare/workers-types"
import { and, eq, isNull, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { CombError } from "../../../error.ts"
import { LruCache } from "../../../lru.ts"
import { combErrorKeys } from "../../../types.ts"
import { openD1Session } from "../session.ts"
import { shardMap } from "./shard-map.ts"
import type { ShardDbHandle, ShardKv, ShardMapping, ShardResolverDeps } from "./types.ts"

/** Structural type so both `@cloudflare/workers-types` and `cloudflare:workers` satisfy it */
type WaitUntilCtx = { waitUntil: (promise: Promise<unknown>) => void }

/** Where a resolved mapping is cached: the KV namespace, written off the request path */
type CacheTargets = { executionCtx: WaitUntilCtx; kv: ShardKv }

/** Pluggable logger — defaults to no-op */
type LogFn = (event: string, data: Record<string, unknown>) => void

interface ShardRouterConfig {
	kvTtlSeconds?: number
	log?: LogFn
	lruHardTtlMs?: number
	lruMaxSize?: number
	lruTtlMs?: number
	maxOrgsPerShard?: number
	totalShards: number
}

const DEFAULTS = {
	kvTtlSeconds: 60,
	lruHardTtlMs: 15 * 60 * 1000,
	lruMaxSize: 1000,
	lruTtlMs: 5 * 60 * 1000,
	maxOrgsPerShard: 500,
} as const

/**
 * Shard router — resolves org -> D1 database handle.
 *
 * Instantiate once per isolate (module-level) so the LRU cache persists.
 * 3-tier lookup: LRU -> KV -> Core D1; a new org goes to the shard with the most headroom.
 */
class ShardRouter {
	private readonly kvTtlSeconds: number
	private readonly log: LogFn
	private readonly lru: LruCache<string, ShardMapping>
	private readonly maxOrgsPerShard: number
	/** Revalidations running now, by org, so concurrent stale hits share one */
	private readonly revalidating = new Map<string, Promise<void>>()
	/**
	 * How many times each org was invalidated in this isolate: a read that began before an
	 * invalidate holds the mapping from before it and must not write it back. The guard is per
	 * isolate; another isolate's in-flight read can still repopulate KV, for at most kvTtlSeconds.
	 */
	private readonly generations = new Map<string, number>()
	private readonly totalShards: number

	constructor(config: ShardRouterConfig) {
		this.totalShards = config.totalShards
		this.maxOrgsPerShard = config.maxOrgsPerShard ?? DEFAULTS.maxOrgsPerShard
		this.kvTtlSeconds = config.kvTtlSeconds ?? DEFAULTS.kvTtlSeconds
		this.log = config.log ?? (() => {})
		this.lru = new LruCache<string, ShardMapping>({
			hardTtlMs: config.lruHardTtlMs ?? DEFAULTS.lruHardTtlMs,
			maxSize: config.lruMaxSize ?? DEFAULTS.lruMaxSize,
			ttlMs: config.lruTtlMs ?? DEFAULTS.lruTtlMs,
		})
	}

	/**
	 * Resolve existing mapping, or allocate a new shard if org is unknown.
	 * This is the primary entry point for middleware.
	 */
	async resolveOrAllocate(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping> {
		const existing = await this.resolve(orgId, deps, executionCtx)
		if (existing) return existing
		return this.allocate(orgId, deps, executionCtx)
	}

	/**
	 * Resolve shard mapping via LRU (SWR) -> KV -> Core D1.
	 * Returns undefined if org has no mapping.
	 * The core read opens a D1 session with no bookmark, so it goes to the nearest replica.
	 */
	async resolve(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping | undefined> {
		/* L1: per-isolate LRU with SWR */
		const lruResult = this.lru.getWithMeta(orgId)
		if (lruResult) {
			this.log("shard-router.hit", { orgId, stale: lruResult.stale, tier: "lru" })
			if (lruResult.stale) this.revalidateOnce(orgId, deps, executionCtx)
			return lruResult.value
		}

		/* L2: KV */
		const generation = this.generationOf(orgId)
		const kvValue = (await deps.kv.get(this.kvKey(orgId), "json")) as ShardMapping | null
		if (kvValue) {
			this.log("shard-router.hit", { orgId, tier: "kv" })
			if (this.generationOf(orgId) === generation) this.lru.set(orgId, kvValue)
			return kvValue
		}

		/* L3: Core D1 — session reads from nearest replica */
		const mapping = await this.readMapping(orgId, deps)
		if (!mapping) {
			this.log("shard-router.miss", { orgId })
			return undefined
		}
		this.log("shard-router.hit", { orgId, tier: "d1" })
		if (this.generationOf(orgId) === generation) this.populateCaches(orgId, mapping, { executionCtx, kv: deps.kv })
		return mapping
	}

	/**
	 * Allocate a shard for an org. A soft-deleted org is revived on the shard it had, where its
	 * data is, even past the cap: moving it would leave its rows behind. A new org goes to the D1
	 * shard with the most headroom; its insert does nothing when a racing router got there first,
	 * and the row read back afterwards is the winner's. Writes go to the primary; the bookmark is
	 * kept for the reads that follow.
	 */
	async allocate(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping> {
		const { client, session } = openD1Session(deps.coreDb, "first-primary")
		const db = drizzle(client)
		const byOrg = eq(shardMap.org_id, orgId)

		const existing = await db.select().from(shardMap).where(byOrg).get()
		const revived = existing !== undefined && existing.deleted_at !== null
		if (revived) {
			await db.update(shardMap).set({ deleted_at: null, updated_at: Date.now() }).where(byOrg)
		} else if (existing === undefined) {
			const shardId = await this.pickShard(db)
			await db
				.insert(shardMap)
				.values({ driver: "d1", org_id: orgId, shard_id: shardId, target: String(shardId) })
				.onConflictDoNothing({ target: shardMap.org_id })
		}

		/* the row that stands now: revived, this router's, or a racer's that got there first */
		const winner = await db.select().from(shardMap).where(byOrg).get()
		const mapping = this.rowToMapping(winner as typeof shardMap.$inferSelect)
		mapping.d1Bookmark = session?.getBookmark() ?? undefined
		this.log("shard-router.allocate", { orgId, shardId: mapping.shardId, ...(revived ? { revived: true } : {}) })
		this.populateCaches(orgId, mapping, { executionCtx, kv: deps.kv })
		return mapping
	}

	/**
	 * Resolve a shard mapping to a concrete D1 database handle.
	 * Reads `SHARD_DB_{target}` binding from env.
	 */
	getHandle(mapping: ShardMapping, env: Record<string, unknown>): ShardDbHandle {
		const binding = env[`SHARD_DB_${mapping.target}`]
		if (!binding) {
			throw new Error(`Missing D1 binding: SHARD_DB_${mapping.target}`)
		}
		return { driver: "d1", handle: binding as D1Database }
	}

	/** Invalidate both cache tiers. Use after whale graduation or reassignment. */
	async invalidate(orgId: string, kv: ShardKv): Promise<void> {
		this.generations.set(orgId, this.generationOf(orgId) + 1)
		this.lru.delete(orgId)
		await kv.delete(this.kvKey(orgId))
	}

	/* -- Private -- */

	private generationOf(orgId: string): number {
		return this.generations.get(orgId) ?? 0
	}

	private kvKey(orgId: string): string {
		return `shard:${orgId}`
	}

	/** The D1 shard with the most remaining capacity; shards_full (503) when none has any */
	private async pickShard(db: ReturnType<typeof drizzle>): Promise<number> {
		const counts = await db
			.select({ count: sql<number>`count(*)`.as("count"), shardId: shardMap.shard_id })
			.from(shardMap)
			.where(and(eq(shardMap.driver, "d1"), isNull(shardMap.deleted_at)))
			.groupBy(shardMap.shard_id)
			.all()
		const usage = new Map(counts.map((row) => [row.shardId, row.count]))
		let best = -1
		let bestHeadroom = 0
		for (let shard = 0; shard < this.totalShards; shard++) {
			const headroom = this.maxOrgsPerShard - (usage.get(shard) ?? 0)
			if (headroom > bestHeadroom) {
				bestHeadroom = headroom
				best = shard
			}
		}
		if (best === -1) {
			/* an operator capacity problem, not the client's: provision another D1 database */
			throw new CombError({
				cause: "No shard has capacity for a new organization.",
				errorKey: combErrorKeys.SHARDS_FULL,
				status: "service_unavailable",
			})
		}
		return best
	}

	private populateCaches(orgId: string, mapping: ShardMapping, { executionCtx, kv }: CacheTargets): void {
		this.lru.set(orgId, mapping)
		executionCtx.waitUntil(
			kv.put(this.kvKey(orgId), JSON.stringify(mapping), {
				expirationTtl: this.kvTtlSeconds,
			}),
		)
	}

	/** The live mapping in the core database, read from the nearest replica; undefined when none */
	private async readMapping(orgId: string, deps: ShardResolverDeps): Promise<ShardMapping | undefined> {
		const { client, session } = openD1Session(deps.coreDb, undefined)
		const row = await drizzle(client)
			.select()
			.from(shardMap)
			.where(and(eq(shardMap.org_id, orgId), isNull(shardMap.deleted_at)))
			.get()
		if (!row) return undefined
		const mapping = this.rowToMapping(row)
		mapping.d1Bookmark = session?.getBookmark() ?? undefined
		return mapping
	}

	/** One background revalidation per org at a time, however many requests see it stale */
	private revalidateOnce(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): void {
		if (this.revalidating.has(orgId)) return
		const running = this.revalidateShard(orgId, deps).finally(() => this.revalidating.delete(orgId))
		this.revalidating.set(orgId, running)
		executionCtx.waitUntil(running)
	}

	/** Background SWR revalidation — refreshes LRU from KV or Core D1 */
	private async revalidateShard(orgId: string, deps: ShardResolverDeps): Promise<void> {
		const generation = this.generationOf(orgId)
		const current = () => this.generationOf(orgId) === generation
		try {
			const kvValue = (await deps.kv.get(this.kvKey(orgId), "json")) as ShardMapping | null
			if (kvValue) {
				if (current()) this.lru.set(orgId, kvValue)
				return
			}
			const mapping = await this.readMapping(orgId, deps)
			if (!mapping || !current()) return
			this.lru.set(orgId, mapping)
			await deps.kv.put(this.kvKey(orgId), JSON.stringify(mapping), { expirationTtl: this.kvTtlSeconds })
		} catch (e) {
			this.log("shard-router.revalidate.error", { error: e, orgId })
		}
	}

	private rowToMapping(row: typeof shardMap.$inferSelect): ShardMapping {
		return {
			createdAt: row.created_at,
			deletedAt: row.deleted_at,
			driver: row.driver,
			orgId: row.org_id,
			shardId: row.shard_id,
			target: row.target,
			updatedAt: row.updated_at,
		}
	}
}

export { ShardRouter, type ShardRouterConfig }
