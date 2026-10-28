/**
 * U33 under G2 of plan 14: a fill's KV write raced against an invalidate, in one isolate and across
 * two, on Miniflare's D1, as anyrow's shard-routing test and its trace showed them.
 */
import type { Miniflare } from "miniflare"
import { afterEach, describe, expect, it } from "vitest"
import { memoryKv, openCore, readThenWait } from "../../../../tests/support/shard-core.ts"
import { ShardRouter } from "./router.ts"
import type { ShardKv } from "./types.ts"

let mf: Miniflare | undefined
const outstanding: Promise<unknown>[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => void outstanding.push(p) }
afterEach(async () => {
	await Promise.allSettled(outstanding.splice(0))
	await mf?.dispose()
	mf = undefined
})

/** A core database with `rows` ([org, shard]) in shard_map */
async function core(rows: Array<[string, number]> = []) {
	const opened = await openCore(rows)
	mf = opened.mf
	return opened
}

/*
 * G2 of plan 14 (U33): a fill that read D1 before another isolate's invalidate lands after it, as
 * anyrow's shard-routing test found: it must not write the old shard back over the invalidation
 */
describe("ShardRouter: a fill that read the core table before an invalidate", () => {
	it("leaves the invalidation standing, so the next isolate reads the moved shard", async () => {
		const { primary } = await core([["org-1", 0]])
		const store = memoryKv()
		const gated: { release?: () => void } = {}
		const gate = new Promise<void>((resolve) => (gated.release = resolve))
		let gets = 0
		/* the fill's own read of KV, the second get, waits until the move and its invalidate are done */
		const kv: ShardKv = {
			...store,
			get: async (key, type) => {
				gets++
				if (gets === 2) await gate
				return store.get(key, type)
			},
		}
		const fills: Promise<unknown>[] = []
		const isolateA = { waitUntil: (p: Promise<unknown>) => void fills.push(p) }
		expect(
			(await new ShardRouter({ totalShards: 3 }).resolve("org-1", { coreDb: primary, kv }, isolateA))?.shardId,
		).toBe(0)
		/* the move a workflow writes by hand, then its invalidate from another isolate */
		await primary
			.prepare("UPDATE shard_map SET shard_id = 1, target = '1', updated_at = updated_at + 1 WHERE org_id = 'org-1'")
			.run()
		await new ShardRouter({ totalShards: 3 }).invalidate("org-1", kv)
		gated.release?.()
		await Promise.all(fills)
		const next = await new ShardRouter({ totalShards: 3 }).resolve("org-1", { coreDb: primary, kv }, ctx)
		expect(next?.shardId).toBe(1)
	})
})

describe("ShardRouter: a fill and an invalidate in one isolate, or across two", () => {
	/* anyrow's shard-routing shape: place's own fill reads KV empty, the same isolate invalidates, then the fill would put */
	it("leaves this isolate's own invalidation standing over the fill of a place it made before", async () => {
		const { primary } = await core([])
		const store = memoryKv()
		const { kv, release } = readThenWait(store)
		const fills: Promise<unknown>[] = []
		const router = new ShardRouter({ totalShards: 3 })
		const deps = { coreDb: primary, kv }
		await router.place({ orgId: "org-1", shardId: 0 }, deps, { waitUntil: (p: Promise<unknown>) => void fills.push(p) })
		await primary
			.prepare("UPDATE shard_map SET shard_id = 1, target = '1', updated_at = updated_at + 1 WHERE org_id = 'org-1'")
			.run()
		await router.invalidate("org-1", kv)
		release()
		await Promise.all(fills)
		expect(
			(await new ShardRouter({ totalShards: 3 }).resolve("org-1", { coreDb: primary, kv: store }, ctx))?.shardId,
		).toBe(1)
	})

	/*
	 * the cross-isolate window anyrow's trace showed: A's fill read D1 before the move and read KV
	 * before B's tombstone, so it puts over it; B, which invalidated, trusts no KV entry read before that
	 */
	it("routes the isolate that invalidated to the moved shard, whatever another's fill put after", async () => {
		const { primary } = await core([["org-1", 0]])
		const store = memoryKv()
		const { kv: held, release } = readThenWait(store)
		let gets = 0
		/* A's second read, its fill's, sees KV as it is and answers only after the move and B's invalidate */
		const kvA: ShardKv = { ...store, get: (key, type) => (++gets === 2 ? held.get(key, type) : store.get(key, type)) }
		const fills: Promise<unknown>[] = []
		const isolateA = { waitUntil: (p: Promise<unknown>) => void fills.push(p) }
		expect(
			(await new ShardRouter({ totalShards: 3 }).resolve("org-1", { coreDb: primary, kv: kvA }, isolateA))?.shardId,
		).toBe(0)
		await primary
			.prepare("UPDATE shard_map SET shard_id = 1, target = '1', updated_at = updated_at + 1 WHERE org_id = 'org-1'")
			.run()
		const routerB = new ShardRouter({ totalShards: 3 })
		await routerB.invalidate("org-1", store)
		release()
		await Promise.all(fills)
		expect((await routerB.resolve("org-1", { coreDb: primary, kv: store }, ctx))?.shardId).toBe(1)
	})
})
