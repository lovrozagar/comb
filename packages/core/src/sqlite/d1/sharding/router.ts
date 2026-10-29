import { type CacheTargets, ShardCache } from "./cache.ts"
import { routerSettings } from "./config.ts"
import type { D1Database } from "@cloudflare/workers-types"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import { openD1Session } from "../session.ts"
import {
	assertShard,
	headroomPick,
	insertFirst,
	overwrite,
	pickShard,
	readLiveRow,
	type ShardRow,
	softDelete,
	toMapping,
} from "./placement.ts"
import { warnOnError } from "../../../log.ts"
import { assertOrgId, ORG_ID_MAX_LENGTH, shardMap } from "./shard-map.ts"
import type {
	LogFn,
	ShardDbHandle,
	ShardMapping,
	ShardMove,
	ShardPick,
	ShardPlacement,
	ShardResolverDeps,
	ShardRouterConfig,
	ShardVerifyDeps,
	WaitUntilCtx,
} from "./types.ts"

/** How a write placed an org: on a new row, on its soft-deleted one, over its live one, or not at all, its live row standing */
type Placement = "allocate" | "move" | "revive" | "standing"

/**
 * Shard router — resolves org -> D1 database handle.
 *
 * Instantiate once per isolate (module-level) so the LRU cache persists.
 * 3-tier lookup: LRU -> KV -> Core D1; a new org goes to the shard `pick` names.
 */
class ShardRouter {
	private readonly cache: ShardCache
	private readonly log: LogFn
	private readonly pick: ShardPick
	private readonly totalShards: number

	constructor(config: ShardRouterConfig) {
		const { kvTtlSeconds, maxOrgsPerShard, totalShards } = routerSettings(config)
		this.totalShards = totalShards
		this.pick = config.pick ?? headroomPick(maxOrgsPerShard)
		/* by default a failure the router absorbs still reaches the console (K15 of r17); pass a log to route or mute it */
		this.log = config.log ?? warnOnError
		this.cache = new ShardCache(config, { kvTtlSeconds, log: this.log })
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
	 * The core read goes to the nearest replica, and to the primary when the replica has no
	 * mapping, which a fresh placement may not have reached yet; a miss there is remembered for
	 * missTtlMs, so a run of requests for an unknown id cannot load the primary.
	 */
	async resolve(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping | undefined> {
		/* an id the column cannot hold is no org's: a miss before KV, whose keys stop at 512 bytes (U41) */
		if (orgId.length > ORG_ID_MAX_LENGTH) {
			this.log("shard-router.miss", { orgId })
			return undefined
		}
		/* L1: per-isolate LRU with SWR */
		const lruResult = this.cache.lru.getWithMeta(orgId)
		if (lruResult) {
			this.log("shard-router.hit", { orgId, stale: lruResult.stale, tier: "lru" })
			if (lruResult.stale) this.cache.revalidateOnce(orgId, deps, executionCtx)
			return lruResult.value
		}

		/* L2: KV, trusted as its tombstone, if any, says */
		const generation = this.cache.generationOf(orgId)
		const lookup = await this.cache.readKv(orgId, deps.kv)
		if (lookup.mapping) {
			this.log("shard-router.hit", { orgId, tier: "kv" })
			this.cache.lru.set(orgId, lookup.mapping)
			return lookup.mapping
		}

		/* L3: Core D1, the primary's when a tombstone fences it or KV failed, unless the primary missed it just now */
		const mapping = this.cache.misses.get(orgId) ? undefined : await ShardCache.readCore(deps.coreDb, orgId, lookup)
		if (!mapping) {
			this.log("shard-router.miss", { orgId })
			if (this.cache.generationOf(orgId) === generation) this.cache.misses.set(orgId, true)
			return undefined
		}
		this.log("shard-router.hit", { orgId, tier: "d1" })
		if (this.cache.generationOf(orgId) === generation) this.cache.fill(mapping, lookup, { executionCtx, kv: deps.kv })
		return mapping
	}

	/**
	 * Resolve as `resolve` does, then check with `deps.present` that the org's rows are on the shard
	 * named: a mapping cached here can predate a `move` in another isolate, since invalidate
	 * reaches only this isolate's LRU and KV. When they are not, the primary is read past every
	 * cache. When it names the shard just probed, the org's rows may not be there yet: that mapping
	 * is returned, and nothing is written or logged (Q13 of r17). When it names another, or none,
	 * the org is invalidated, the primary read again under the tombstone, and that mapping, or
	 * undefined when the org is gone, returned without a second probe; it is cached only while no
	 * invalidate here, a move's among them, came after the tombstone (Q7 of r17).
	 */
	async resolveVerified(
		orgId: string,
		deps: ShardVerifyDeps,
		executionCtx: WaitUntilCtx,
	): Promise<ShardMapping | undefined> {
		const cached = await this.resolve(orgId, deps, executionCtx)
		if (!cached || (await deps.present(cached))) return cached
		const primary = (await readLiveRow(deps.coreDb, orgId, "first-primary")).mapping
		if (primary?.shardId === cached.shardId) return primary
		/* the primary's mapping read again after the tombstone, so it is tagged with it */
		const tag = await this.cache.invalidate(orgId, deps.kv)
		const generation = this.cache.generationOf(orgId)
		const { mapping } = await readLiveRow(deps.coreDb, orgId, "first-primary")
		this.log("shard-router.reresolve", { from: cached.shardId, orgId, to: mapping?.shardId })
		if (mapping && this.cache.generationOf(orgId) === generation)
			this.cache.populate(orgId, mapping, { executionCtx, kv: deps.kv, tag })
		return mapping
	}

	/**
	 * Allocate a shard for an org: the one `pick` names, told each shard's live count. A
	 * soft-deleted org is revived on the shard it had, where its data is, without asking pick. The
	 * count is read before the insert, so two isolates allocating at once can both take a shard's
	 * last place: maxOrgsPerShard is a soft cap. Writes go to the primary.
	 */
	async allocate(orgId: string, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping> {
		assertOrgId(orgId)
		const db = drizzle(openD1Session(deps.coreDb).client)
		const existing = await db.select().from(shardMap).where(eq(shardMap.org_id, orgId)).get()
		const shardId = existing?.shard_id ?? (await pickShard(db, this.pick, { orgId, totalShards: this.totalShards }))
		return this.placeFirst({ orgId, shardId }, deps, executionCtx)
	}

	/**
	 * Place an org on a shard the app chose. The first writer wins: an org that has a row keeps
	 * its shard, a soft-deleted one revived there, and the mapping that stands is returned, so two
	 * isolates placing one new org at once agree. To put a placed org elsewhere, `move` it.
	 */
	async place(placement: ShardPlacement, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping> {
		assertOrgId(placement.orgId)
		assertShard(placement.shardId, this.totalShards)
		return this.placeFirst(placement, deps, executionCtx)
	}

	/**
	 * Move an org to `shardId` and invalidate it here. Moving its rows is the app's; its writes on
	 * the core database for the move (`with`) batch with the mapping's, landing together or not at
	 * all (R4). Another isolate routes to the old shard until its caches expire or it verifies.
	 */
	async move(placement: ShardMove, deps: ShardResolverDeps, executionCtx: WaitUntilCtx): Promise<ShardMapping> {
		const { orgId, shardId } = placement
		assertOrgId(orgId)
		assertShard(shardId, this.totalShards)
		const row = await overwrite(openD1Session(deps.coreDb).client, placement)
		/* the tombstone after the commit, then the moved row warms KV tagged with it */
		const tag = await this.cache.invalidate(orgId, deps.kv)
		return this.settle(row, "move", { executionCtx, kv: deps.kv, tag })
	}

	/** Soft-delete an org's mapping and invalidate it here; a later allocate or place revives it on its shard */
	async unplace(orgId: string, deps: ShardResolverDeps): Promise<void> {
		await softDelete(drizzle(openD1Session(deps.coreDb).client), orgId)
		await this.invalidate(orgId, deps.kv)
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

	/**
	 * Invalidate both cache tiers. Use after whale graduation or reassignment. It reaches this
	 * isolate's LRU and the KV; another isolate's LRU keeps the mapping until it expires.
	 */
	async invalidate(orgId: string, kv: ShardResolverDeps["kv"]): Promise<void> {
		await this.cache.invalidate(orgId, kv)
	}

	/* -- Private -- */

	/** Places an org as `place` does, unchecked: an org being revived keeps the shard it had */
	private async placeFirst(
		{ orgId, shardId }: ShardPlacement,
		deps: ShardResolverDeps,
		executionCtx: WaitUntilCtx,
	): Promise<ShardMapping> {
		const { how, row } = await insertFirst(drizzle(openD1Session(deps.coreDb).client), orgId, shardId)
		/* written after this isolate's live tombstone, if it holds one, so tagged with it: other isolates trust it (Q17 of r17) */
		return this.settle(row, how, { executionCtx, kv: deps.kv, tag: this.cache.tombstoneOf(orgId) })
	}

	/**
	 * Caches the row a write left standing, this isolate's miss for the org forgotten, and returns
	 * its mapping; logs the placement only when the write placed it, so the events count rows (U40)
	 */
	private settle(row: ShardRow, how: Placement, targets: CacheTargets): ShardMapping {
		const mapping = toMapping(row)
		const data = { orgId: row.org_id, shardId: row.shard_id }
		if (how !== "standing")
			this.log(
				`shard-router.${how === "move" ? "move" : "allocate"}`,
				how === "revive" ? { ...data, revived: true } : data,
			)
		this.cache.misses.delete(row.org_id)
		this.cache.populate(row.org_id, mapping, targets)
		return mapping
	}
}

export { ShardRouter }
