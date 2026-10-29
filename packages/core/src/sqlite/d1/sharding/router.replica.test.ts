/**
 * Q7 and C1 of the 0.14.1 review: after a remap, a core read from a replica that has not seen it,
 * or one that began before it, must not route anyone to the old shard once the invalidate's
 * tombstone is visible, whatever the isolates' clocks say. On Miniflare's D1, with a second
 * database as the lagging replica.
 */
import type { D1Database } from "@cloudflare/workers-types"
import type { Miniflare } from "miniflare"
import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryKv, openCore, readsThenWaits, replicated } from "../../../../tests/support/shard-core.ts"
import { ShardRouter } from "./router.ts"
import type { ShardKv } from "./types.ts"

let mf: Miniflare | undefined
const outstanding: Promise<unknown>[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => void outstanding.push(p) }
const settle = () => Promise.allSettled(outstanding.splice(0))
afterEach(async () => {
	vi.restoreAllMocks()
	await settle()
	await mf?.dispose()
	mf = undefined
})

/* anyrow's router config (common/src/shard-router/anyrow.common.shard-router-default.ts) */
const CONFIG = { kvTtlSeconds: 60, lruHardTtlMs: 30_000, lruTtlMs: 30_000, totalShards: 2 } as const
const router = () => new ShardRouter(CONFIG)

/** org-1 on shard 0 on the primary and on its replica */
async function placed() {
	const opened = await openCore([["org-1", 0]])
	mf = opened.mf
	await opened.replica.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES ('org-1', 0, '0')").run()
	return { ...opened, ...replicated(opened.primary, opened.replica) }
}

/** The remap a workflow writes by hand on the primary; the replica has not seen it */
const remap = (primary: D1Database) =>
	primary
		.prepare("UPDATE shard_map SET shard_id = 1, target = '1', updated_at = updated_at + 1 WHERE org_id = 'org-1'")
		.run()

/** The replica catching up with the remap */
const catchUp = (replica: D1Database) =>
	replica
		.prepare("UPDATE shard_map SET shard_id = 1, target = '1', updated_at = updated_at + 1 WHERE org_id = 'org-1'")
		.run()

const shardOf = async (r: ShardRouter, deps: { coreDb: D1Database; kv: ShardKv }) =>
	(await r.resolve("org-1", deps, ctx))?.shardId

/** `store` whose puts of a mapping wait for `release`: a fill that read before an invalidate, landing after it */
function putsLater(store: ShardKv): { kv: ShardKv; release: () => void } {
	const gated: { release: () => void } = { release: () => undefined }
	const gate = new Promise<void>((resolve) => (gated.release = resolve))
	const kv: ShardKv = {
		...store,
		put: async (key, value, options) => {
			if (key.startsWith("shard:")) await gate
			await store.put(key, value, options)
		},
	}
	return { kv, release: () => gated.release() }
}

/** Another colo's view of `store`: tombstones reach it only on `propagate`, as KV spreads a write eventually */
function laterColo(store: ShardKv): { kv: ShardKv; propagate: () => void } {
	const seen = { tombstones: false }
	const kv: ShardKv = {
		...store,
		get: async (key, type) => (key.startsWith("shard-inv:") && !seen.tombstones ? null : store.get(key, type)),
	}
	return { kv, propagate: () => void (seen.tombstones = true) }
}

describe("ShardRouter after a remap, with the replica behind it", () => {
	/* C1: anyrow's shape, a raw UPDATE then invalidate, as its shard-move workflow does */
	it("routes every isolate to the new shard, the invalidating one included, through the lag and after it", async () => {
		const { coreDb, primary, replica } = await placed()
		const kv = memoryKv()
		const mover = router()
		await remap(primary)
		await mover.invalidate("org-1", kv)
		expect(await shardOf(router(), { coreDb, kv })).toBe(1)
		await settle()
		await catchUp(replica)
		expect(await shardOf(router(), { coreDb, kv })).toBe(1)
		expect(await shardOf(mover, { coreDb, kv })).toBe(1)
	})

	/* Q7 (A): the isolate that invalidated is never misled, its next resolve reading through the lag */
	it("routes the invalidating isolate's own next resolve to the new shard, and leaves it in KV for the next", async () => {
		const { coreDb, primary, replica } = await placed()
		const kv = memoryKv()
		const a = router()
		await remap(primary)
		await a.invalidate("org-1", kv)
		expect(await shardOf(a, { coreDb, kv })).toBe(1)
		await settle()
		await catchUp(replica)
		const fresh = replicated(primary, replica)
		expect(await shardOf(router(), { coreDb: fresh.coreDb, kv })).toBe(1)
		/* the fill A made through the lag is trusted from KV: no core read */
		expect(fresh.reads).toEqual({ primary: 0, replica: 0 })
	})

	/* Q7 (B) and C1's move(): the moved row warms KV, after move's own invalidate, so no isolate reads the replica */
	it("routes a fresh isolate to where move() put the org from KV, and keeps routing it there", async () => {
		const { coreDb, reads, replica } = await placed()
		const kv = memoryKv()
		await router().move({ orgId: "org-1", shardId: 1 }, { coreDb, kv }, ctx)
		await settle()
		const before = { ...reads }
		const c = router()
		expect(await shardOf(c, { coreDb, kv })).toBe(1)
		expect(reads).toEqual(before)
		await catchUp(replica)
		expect(await shardOf(c, { coreDb, kv })).toBe(1)
	})

	it("puts move()'s tombstone before the moved mapping", async () => {
		const { coreDb } = await placed()
		const store = memoryKv()
		const ops: string[] = []
		const kv: ShardKv = {
			delete: async (key) => (ops.push(`delete ${key}`), store.delete(key)),
			get: (key, type) => store.get(key, type),
			put: async (key, value, options) => (ops.push(`put ${key}`), store.put(key, value, options)),
		}
		await router().move({ orgId: "org-1", shardId: 1 }, { coreDb, kv }, ctx)
		await settle()
		expect(ops).toEqual(["put shard-inv:org-1", "delete shard:org-1", "put shard:org-1"])
	})
})

describe("ShardRouter: a stale fill that lands after the tombstone", () => {
	it("is not trusted while the tombstone lives, by any isolate", async () => {
		const { coreDb, primary } = await placed()
		const store = memoryKv()
		const { kv: slow, release } = putsLater(store)
		/* isolate X resolves before the remap; its KV put is still in flight */
		expect(await shardOf(router(), { coreDb, kv: slow })).toBe(0)
		const mover = router()
		await remap(primary)
		await mover.invalidate("org-1", store)
		release()
		await settle()
		expect(await shardOf(router(), { coreDb, kv: store })).toBe(1)
		expect(await shardOf(mover, { coreDb, kv: store })).toBe(1)
	})

	/* no clock decides freshness: a fill that read before the remap is stopped as well with the invalidating isolate's clock off */
	it.each([-600_000, 600_000])("is not trusted with the invalidating isolate's clock off by %i ms", async (skew) => {
		const { primary } = await placed()
		const kv = memoryKv()
		const gated: { release?: () => void } = {}
		const gate = new Promise<void>((resolve) => (gated.release = resolve))
		/* isolate X's core read answers the row from before the remap, and returns after the invalidate */
		const held = readsThenWaits(primary, gate)
		const x = router().resolve("org-1", { coreDb: held.coreDb, kv }, ctx)
		await held.answered
		await remap(primary)
		const real = Date.now
		vi.spyOn(Date, "now").mockImplementation(() => real() + skew)
		await router().invalidate("org-1", kv)
		vi.restoreAllMocks()
		gated.release?.()
		expect((await x)?.shardId).toBe(0)
		await settle()
		expect(await shardOf(router(), { coreDb: primary, kv })).toBe(1)
	})
})

describe("ShardRouter: another colo that sees the tombstone late", () => {
	it("routes there to the new shard once the tombstone is visible, over the stale fill it made before", async () => {
		const { coreDb, primary } = await placed()
		const store = memoryKv()
		const colo = laterColo(store)
		await remap(primary)
		await router().invalidate("org-1", store)
		/* inside KV's propagation window the colo reads its replica and puts what it read: the documented bound */
		expect(await shardOf(router(), { coreDb, kv: colo.kv })).toBe(0)
		await settle()
		colo.propagate()
		expect(await shardOf(router(), { coreDb, kv: colo.kv })).toBe(1)
		expect(await shardOf(router(), { coreDb, kv: store })).toBe(1)
	})
})

/* C17 of the 0.14.1 review: a fill's session bookmark is no other request's */
describe("ShardRouter: a cached mapping", () => {
	it("carries no session bookmark, from the core table, KV or this isolate's LRU, nor one an older fill left in KV", async () => {
		const { coreDb } = await placed()
		const kv = memoryKv()
		const filler = router()
		const read = await filler.resolve("org-1", { coreDb, kv }, ctx)
		await settle()
		const fromLru = await filler.resolve("org-1", { coreDb, kv }, ctx)
		const fromKv = await router().resolve("org-1", { coreDb, kv }, ctx)
		const stored = (await kv.get("shard:org-1", "json")) as object
		await kv.put("shard:org-1", JSON.stringify({ ...stored, d1Bookmark: "bk-of-0.14" }))
		const fromOldKv = await router().resolve("org-1", { coreDb, kv }, ctx)
		for (const mapping of [read, fromLru, fromKv, fromOldKv]) expect(mapping).not.toHaveProperty("d1Bookmark")
		expect(stored).not.toHaveProperty("d1Bookmark")
	})
})
