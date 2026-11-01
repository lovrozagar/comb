/**
 * U33 under G2 of plan 14: a fill's KV write raced against an invalidate, in one isolate and across
 * two, on Miniflare's D1, as anyrow's shard-routing test and its trace showed them.
 * Its cross-isolate cases, a fill that read before an invalidate and lands after it, are now
 * router.replica.test.ts's, which no longer count KV gets.
 */
import type { Miniflare } from "miniflare"
import { afterEach, describe, expect, it } from "vitest"
import { batchesThenWait, memoryKv, openCore, readThenWait } from "../../../../tests/support/shard-core.ts"
import { ShardRouter } from "./router.ts"

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
})

/** A place of org-1 on shard 2 whose write read its row on shard 0, then org-1 moved to 1, then the place returned */
async function placedAcrossMove() {
	const { primary } = await core([["org-1", 0]])
	const kv = memoryKv()
	const gate: { open: () => void } = { open: () => undefined }
	const { answered, coreDb } = batchesThenWait(primary, new Promise<void>((resolve) => (gate.open = resolve)))
	const router = new ShardRouter({ totalShards: 3 })
	const placing = router.place({ orgId: "org-1", shardId: 2 }, { coreDb, kv }, ctx)
	await answered
	await router.move({ orgId: "org-1", shardId: 1 }, { coreDb, kv }, ctx)
	await Promise.all(outstanding.splice(0))
	gate.open()
	const placed = await placing
	await Promise.all(outstanding.splice(0))
	return { kv, placed, primary, router }
}

/* Q6 of r18: a place's write read the standing row, then a move in the same isolate committed and invalidated */
describe("ShardRouter: a place that read before a move in its isolate, settling after it", () => {
	it("returns the row its write read, and leaves the move's mapping for this isolate", async () => {
		const { kv, placed, primary, router } = await placedAcrossMove()
		expect(placed.shardId).toBe(0)
		expect((await router.resolve("org-1", { coreDb: primary, kv }, ctx))?.shardId).toBe(1)
	})

	it("caches nothing another isolate trusts as the org's shard", async () => {
		const { kv, primary } = await placedAcrossMove()
		const other = new ShardRouter({ totalShards: 3 })
		expect((await other.resolve("org-1", { coreDb: primary, kv }, ctx))?.shardId).toBe(1)
	})
})

/* the same rule for a move: an invalidate here during its own tombstone write is another's, which may have remapped */
describe("ShardRouter: a move whose tombstone write waits while another move runs", () => {
	it("leaves the later move's mapping for this isolate", async () => {
		const { primary } = await core([["org-1", 0]])
		const store = memoryKv()
		const gate: { open: () => void } = { open: () => undefined }
		const opened = new Promise<void>((resolve) => (gate.open = resolve))
		let held = true
		const kv = {
			...store,
			put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
				await store.put(key, value, options)
				if (!held || !key.startsWith("shard-inv:")) return
				held = false
				await opened
			},
		}
		const router = new ShardRouter({ totalShards: 3 })
		const first = router.move({ orgId: "org-1", shardId: 1 }, { coreDb: primary, kv }, ctx)
		await expect.poll(() => held).toBe(false)
		await router.move({ orgId: "org-1", shardId: 2 }, { coreDb: primary, kv }, ctx)
		gate.open()
		await first
		await Promise.all(outstanding.splice(0))
		expect((await router.resolve("org-1", { coreDb: primary, kv }, ctx))?.shardId).toBe(2)
	})
})
