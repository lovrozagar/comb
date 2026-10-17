/**
 * ShardRouter against D1 and KV on Miniflare: racing first requests agree on one mapping, a
 * soft-deleted org can be allocated again, stale cache hits share one revalidation, and every
 * lookup reports what it did through `log`.
 */
import type { KVNamespace } from "@cloudflare/workers-types"
import { afterEach, describe, expect, it } from "vitest"
import { ShardRouter } from "../../../src/sqlite/d1/sharding/router.ts"
import { type D1Harness, d1Memory } from "../support/d1.ts"

const DDL = `CREATE TABLE shard_map (
	created_at integer NOT NULL DEFAULT (unixepoch() * 1000),
	deleted_at integer,
	driver text NOT NULL DEFAULT 'd1',
	org_id text PRIMARY KEY,
	shard_id integer NOT NULL,
	target text NOT NULL,
	updated_at integer NOT NULL DEFAULT (unixepoch() * 1000)
)`

let harness: D1Harness | undefined
/* the current world's waitUntil promises, settled before its bindings are disposed */
let pending: Promise<unknown>[] = []
afterEach(async () => {
	await Promise.allSettled(pending.splice(0))
	await harness?.dispose()
	harness = undefined
})

/** A fresh core database and KV, and a waitUntil whose promises a test can settle */
async function world() {
	harness = await d1Memory()
	await harness.CORE.exec(DDL.replaceAll("\n", " "))
	pending = []
	const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) }
	const settle = () => Promise.all(pending.splice(0))
	return { ctx, deps: { coreDb: harness.CORE, kv: harness.KV }, harness, settle }
}

type Event = [string, Record<string, unknown>]

function router(events: Event[] = [], config: Partial<ConstructorParameters<typeof ShardRouter>[0]> = {}) {
	return new ShardRouter({ log: (event, data) => events.push([event, data]), totalShards: 4, ...config })
}

describe("allocation (S-1, S-2)", () => {
	it("gives two routers racing on a new org the same mapping, from one row", async () => {
		const { ctx, deps, harness: h } = await world()
		const [a, b] = await Promise.all([
			router().resolveOrAllocate("org_1", deps, ctx),
			router().resolveOrAllocate("org_1", deps, ctx),
		])
		expect(a.shardId).toBe(b.shardId)
		expect(a.target).toBe(b.target)
		const { results } = await h.CORE.prepare("SELECT count(*) AS n FROM shard_map").all<{ n: number }>()
		expect(results[0]?.n).toBe(1)
	})

	it("allocates a soft-deleted org again, reviving its row", async () => {
		const { ctx, deps, harness: h, settle } = await world()
		const first = router()
		await first.resolveOrAllocate("org_2", deps, ctx)
		await settle()
		await h.CORE.prepare("UPDATE shard_map SET deleted_at = 1 WHERE org_id = 'org_2'").run()
		await first.invalidate("org_2", deps.kv)
		const again = await router().resolveOrAllocate("org_2", deps, ctx)
		expect(again.deletedAt).toBeNull()
		const { results } = await h.CORE.prepare("SELECT deleted_at FROM shard_map WHERE org_id = 'org_2'").all()
		expect(results).toEqual([{ deleted_at: null }])
	})
})

describe("revival and capacity (REVIEW 3.4)", () => {
	it("revives a soft-deleted org on the shard its data is on, even when another has more headroom", async () => {
		const { ctx, deps, harness: h, settle } = await world()
		const events: Event[] = []
		const two = (log: Event[] = []) => router(log, { maxOrgsPerShard: 2, totalShards: 2 })
		const first = await two().resolveOrAllocate("org_old", deps, ctx)
		expect(first.shardId).toBe(0)
		await h.CORE.prepare("UPDATE shard_map SET deleted_at = 1 WHERE org_id = 'org_old'").run()
		/* shard 0 now fills up, so shard 1 has the most headroom */
		await h.CORE.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES ('a', 0, '0'), ('b', 0, '0')").run()
		await settle()
		await deps.kv.delete("shard:org_old")

		const revived = await two(events).resolveOrAllocate("org_old", deps, ctx)
		expect(revived).toMatchObject({ deletedAt: null, shardId: 0, target: "0" })
		expect(events.at(-1)).toEqual(["shard-router.allocate", { orgId: "org_old", revived: true, shardId: 0 }])
	})

	it("refuses a new org with shards_full (503) when every shard is at the cap", async () => {
		const { ctx, deps, harness: h } = await world()
		await h.CORE.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES ('a', 0, '0'), ('b', 1, '1')").run()
		const full = router([], { maxOrgsPerShard: 1, totalShards: 2 })
		await expect(full.resolveOrAllocate("org_new", deps, ctx)).rejects.toMatchObject({
			cause: "No shard has capacity for a new organization.",
			errorKey: "shards_full",
			status: 503,
		})
	})
})

describe("stale cache hits (SWR)", () => {
	it("starts one revalidation however many requests see the stale entry", async () => {
		const { ctx, deps, settle } = await world()
		const shared = router([], { lruTtlMs: 1 })
		await shared.resolveOrAllocate("org_3", deps, ctx)
		await settle()
		await new Promise((resolve) => setTimeout(resolve, 5))
		let reads = 0
		const kv = deps.kv
		const counting = {
			...kv,
			delete: kv.delete.bind(kv),
			get: ((key: string, type: "json") => {
				reads++
				return kv.get(key, type)
			}) as unknown as KVNamespace["get"],
			put: kv.put.bind(kv),
		} as KVNamespace
		await Promise.all(Array.from({ length: 5 }, () => shared.resolve("org_3", { ...deps, kv: counting }, ctx)))
		await settle()
		expect(reads).toBe(1)
	})
})

describe("log (S-14)", () => {
	it("reports a miss and an allocation, then a hit on each cache tier", async () => {
		const { ctx, deps, settle } = await world()
		const events: Event[] = []
		const first = router(events)
		await first.resolveOrAllocate("org_4", deps, ctx)
		await settle()
		await first.resolve("org_4", deps, ctx)
		await router(events).resolve("org_4", deps, ctx)
		expect(events.map(([event, data]) => [event, data["tier"] ?? data["shardId"] ?? null])).toEqual([
			["shard-router.miss", null],
			["shard-router.allocate", 0],
			["shard-router.hit", "lru"],
			["shard-router.hit", "kv"],
		])
	})

	it("reports a failed revalidation", async () => {
		const { ctx, deps, settle } = await world()
		const events: Event[] = []
		const shared = router(events, { lruTtlMs: 1 })
		await shared.resolveOrAllocate("org_5", deps, ctx)
		await settle()
		await new Promise((resolve) => setTimeout(resolve, 5))
		const broken = { ...deps.kv, get: () => Promise.reject(new Error("kv down")) } as unknown as KVNamespace
		await shared.resolve("org_5", { ...deps, kv: broken }, ctx)
		await settle()
		expect(events.at(-1)?.[0]).toBe("shard-router.revalidate.error")
	})
})
