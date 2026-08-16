import type { D1Database, KVNamespace } from "@cloudflare/workers-types"
import { and, eq, isNull, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { LruCache } from "../../../lru.ts"
import { openD1Session } from "../session.ts"
import { shardMap } from "./shard-map.ts"
import type { ShardDbHandle, ShardMapping, ShardResolverDeps } from "./types.ts"

/** Structural type so both `@cloudflare/workers-types` and `cloudflare:workers` satisfy it */
type WaitUntilCtx = { waitUntil: (promise: Promise<unknown>) => void }

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
 * 3-tier lookup: LRU -> KV -> Core D1, with fill-then-next allocation.
 */
class ShardRouter {
	private readonly kvTtlSeconds: number
	private readonly log: LogFn
	private readonly lru: LruCache<string, ShardMapping>
	private readonly maxOrgsPerShard: number
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
	 * Uses D1 Sessions API — reads hit nearest replica via bookmark from KV cache.
	 */
	async resolve(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping | undefined> {
		/* L1: per-isolate LRU with SWR */
		const lruResult = this.lru.getWithMeta(orgId)
		if (lruResult) {
			if (lruResult.stale) {
				executionCtx.waitUntil(this.revalidateShard(orgId, deps))
			}
			return lruResult.value
		}

		/* L2: KV */
		const kvValue = await deps.kv.get<ShardMapping>(this.kvKey(orgId), "json")
		if (kvValue) {
			this.lru.set(orgId, kvValue)
			return kvValue
		}

		/* L3: Core D1 — session reads from nearest replica */
		const { client, session } = openD1Session(deps.coreDb, undefined)
		const db = drizzle(client)
		const row = await db
			.select()
			.from(shardMap)
			.where(and(eq(shardMap.org_id, orgId), isNull(shardMap.deleted_at)))
			.get()
		if (!row) return undefined

		const mapping = this.rowToMapping(row)
		mapping.d1Bookmark = session?.getBookmark() ?? undefined
		this.populateCaches(orgId, mapping, deps.kv, executionCtx)
		return mapping
	}

	/**
	 * Allocate shard for a new org using fill-then-next strategy.
	 * Picks the D1 shard with most headroom.
	 * Uses primary-first session — writes always hit primary, bookmark stored for subsequent reads.
	 */
	async allocate(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping> {
		const { client, session } = openD1Session(deps.coreDb, "first-primary")
		const db = drizzle(client)

		const counts = await db
			.select({
				count: sql<number>`count(*)`.as("count"),
				shardId: shardMap.shard_id,
			})
			.from(shardMap)
			.where(and(eq(shardMap.driver, "d1"), isNull(shardMap.deleted_at)))
			.groupBy(shardMap.shard_id)
			.all()

		const bestShard = this.pickBestShard(counts)

		const target = String(bestShard)
		await db.insert(shardMap).values({
			driver: "d1",
			org_id: orgId,
			shard_id: bestShard,
			target,
		})

		const now = Date.now()
		const mapping: ShardMapping = {
			createdAt: now,
			d1Bookmark: session?.getBookmark() ?? undefined,
			deletedAt: null,
			driver: "d1",
			orgId,
			shardId: bestShard,
			target,
			updatedAt: now,
		}

		this.populateCaches(orgId, mapping, deps.kv, executionCtx)
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
	async invalidate(orgId: string, kv: KVNamespace): Promise<void> {
		this.lru.delete(orgId)
		await kv.delete(this.kvKey(orgId))
	}

	/* -- Private -- */

	private kvKey(orgId: string): string {
		return `shard:${orgId}`
	}

	/**
	 * Scan all shards, return the one with most remaining capacity.
	 * Throws when every shard is full.
	 */
	private pickBestShard(counts: Array<{ count: number; shardId: number }>): number {
		const usage = new Map<number, number>()
		for (const row of counts) {
			usage.set(row.shardId, row.count)
		}

		let bestShard = -1
		let bestHeadroom = -1
		for (let i = 0; i < this.totalShards; i++) {
			const headroom = this.maxOrgsPerShard - (usage.get(i) ?? 0)
			if (headroom > bestHeadroom) {
				bestHeadroom = headroom
				bestShard = i
			}
		}

		if (bestShard === -1 || bestHeadroom <= 0) {
			throw new Error("All shards full — provision a new D1 database")
		}
		return bestShard
	}

	private populateCaches(orgId: string, mapping: ShardMapping, kv: KVNamespace, executionCtx: WaitUntilCtx): void {
		this.lru.set(orgId, mapping)
		executionCtx.waitUntil(
			kv.put(this.kvKey(orgId), JSON.stringify(mapping), {
				expirationTtl: this.kvTtlSeconds,
			}),
		)
	}

	/** Background SWR revalidation — refreshes LRU from KV or Core D1 */
	private async revalidateShard(orgId: string, deps: ShardResolverDeps): Promise<void> {
		try {
			const kvValue = await deps.kv.get<ShardMapping>(this.kvKey(orgId), "json")
			if (kvValue) {
				this.lru.set(orgId, kvValue)
				return
			}

			const { client, session } = openD1Session(deps.coreDb, undefined)
			const db = drizzle(client)
			const row = await db
				.select()
				.from(shardMap)
				.where(and(eq(shardMap.org_id, orgId), isNull(shardMap.deleted_at)))
				.get()
			if (row) {
				const mapping = this.rowToMapping(row)
				mapping.d1Bookmark = session?.getBookmark() ?? undefined
				this.lru.set(orgId, mapping)
				await deps.kv.put(this.kvKey(orgId), JSON.stringify(mapping), {
					expirationTtl: this.kvTtlSeconds,
				})
			}
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
