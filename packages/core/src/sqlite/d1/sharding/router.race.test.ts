/**
 * U33 under G2 of plan 14: a fill's KV write raced against an invalidate, in one isolate and across
 * two, on Miniflare's D1, as anyrow's shard-routing test and its trace showed them.
 * Its cross-isolate cases, a fill that read before an invalidate and lands after it, are now
 * router.replica.test.ts's, which no longer count KV gets.
 */
import type { Miniflare } from "miniflare"
import { afterEach, describe, expect, it } from "vitest"
import { memoryKv, openCore, readThenWait } from "../../../../tests/support/shard-core.ts"
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
