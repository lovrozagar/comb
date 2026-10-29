/**
 * r17's shard-router findings on Miniflare's D1: a failed tombstone read trusts nothing in KV (Q6),
 * resolveVerified reads the primary before it invalidates and never overwrites a move made here
 * meanwhile (Q7, Q13), a revive under this isolate's live tombstone is tagged with it (Q17), and a
 * router given no log still reports its KV failures (K15).
 */
import type { D1Database } from "@cloudflare/workers-types"
import type { Miniflare } from "miniflare"
import { afterEach, describe, expect, it, vi } from "vitest"
import { memoryKv, openCore, replicated } from "../../../../tests/support/shard-core.ts"
import { ShardRouter } from "./router.ts"
import type { ShardKv } from "./types.ts"

let mf: Miniflare | undefined
const outstanding: Promise<unknown>[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => void outstanding.push(p) }
const settle = () => Promise.allSettled(outstanding.splice(0))
afterEach(async () => {
	await settle()
	await mf?.dispose()
	mf = undefined
	vi.restoreAllMocks()
})

/** A core database with `rows` ([org, shard]) in shard_map */
async function core(rows: Array<[string, number]> = []) {
	const opened = await openCore(rows)
	mf = opened.mf
	return opened
}

/** `store` whose get of the tombstone key throws */
const tombstoneUnreadable = (store: ShardKv): ShardKv => ({
	...store,
	get: async (key, type) => {
		if (key.startsWith("shard-inv:")) throw new Error("KV 503")
		return store.get(key, type)
	},
})

describe("ShardRouter when KV fails to read the tombstone (Q6)", () => {
	it("reads the primary, and caches what it read in the LRU only, never in KV", async () => {
		const { primary, replica } = await core([["org-1", 1]])
		/* a stale mapping in KV, the replica still behind the move */
		await replica.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES ('org-1', 0, '0')").run()
		const { coreDb, reads } = replicated(primary, replica)
		const store = memoryKv()
		await store.put("shard:org-1", JSON.stringify({ driver: "d1", orgId: "org-1", shardId: 0, target: "0" }))
		const errors: string[] = []
		const router = new ShardRouter({ log: (event) => void errors.push(event), totalShards: 3 })
		const resolved = await router.resolve("org-1", { coreDb, kv: tombstoneUnreadable(store) }, ctx)
		await settle()
		expect(resolved?.shardId).toBe(1)
		expect(reads.primary).toBeGreaterThan(0)
		expect(errors).toContain("shard-router.kv.error")
		/* KV still holds the stale mapping, untouched; this isolate routes by its LRU */
		expect(await store.get("shard:org-1", "json")).toMatchObject({ shardId: 0 })
		expect((await router.resolve("org-1", { coreDb, kv: store }, ctx))?.shardId).toBe(1)
	})

	it("revalidates a stale entry from the primary into the LRU alone", async () => {
		const { primary } = await core([["org-1", 0]])
		const store = memoryKv()
		const router = new ShardRouter({ lruTtlMs: 1, totalShards: 3 })
		await router.resolve("org-1", { coreDb: primary, kv: store }, ctx)
		await settle()
		await primary.prepare("UPDATE shard_map SET shard_id = 1, target = '1' WHERE org_id = 'org-1'").run()
		await new Promise((resolve) => setTimeout(resolve, 5))
		/* stale: served as it is, revalidated in the background past the KV it cannot trust */
		expect((await router.resolve("org-1", { coreDb: primary, kv: tombstoneUnreadable(store) }, ctx))?.shardId).toBe(0)
		await settle()
		expect(await store.get("shard:org-1", "json")).toMatchObject({ shardId: 0 })
		await expect(router.resolve("org-1", { coreDb: primary, kv: store }, ctx)).resolves.toMatchObject({ shardId: 1 })
	})
})

/** A core database whose primary SELECTs, once armed, answer and then wait for `release` */
function heldPrimary(primary: D1Database) {
	const state = { armed: false }
	const { promise: gate, resolve: release } = Promise.withResolvers<void>()
	const { promise: answered, resolve: answer } = Promise.withResolvers<void>()
	const held = <T extends object>(statement: T): T =>
		new Proxy(statement, {
			get(target, key) {
				const value = Reflect.get(target, key) as unknown
				if (typeof value !== "function") return value
				if (key === "bind") return (...args: unknown[]) => held(value.apply(target, args) as object)
				return async (...args: unknown[]) => {
					const result = await value.apply(target, args)
					answer()
					await gate
					return result
				}
			},
		})
	const prepare = (query: string) =>
		state.armed && /^select/i.test(query) ? held(primary.prepare(query)) : primary.prepare(query)
	const session = { batch: (s: unknown) => primary.batch(s as never), getBookmark: () => "bk", prepare }
	const coreDb = { batch: session.batch, prepare, withSession: () => session } as unknown as D1Database
	return { answered, coreDb, release, state }
}

describe("ShardRouter.resolveVerified (Q7, Q13)", () => {
	it("leaves a move this isolate made during its primary read standing in the LRU", async () => {
		const { primary } = await core([["org-1", 0]])
		const { answered, coreDb, release, state } = heldPrimary(primary)
		const kv = memoryKv()
		const router = new ShardRouter({ totalShards: 3 })
		expect((await router.resolve("org-1", { coreDb, kv }, ctx))?.shardId).toBe(0)
		/* the rows are already on shard 1; the probe of shard 0 arms the held read */
		const present = async ({ shardId }: { shardId: number }) => ((state.armed = shardId === 0), shardId === 1)
		const verifying = router.resolveVerified("org-1", { coreDb, kv, present }, ctx)
		await answered
		state.armed = false
		await router.move({ orgId: "org-1", shardId: 1 }, { coreDb, kv }, ctx)
		release()
		await verifying
		await settle()
		expect((await router.resolve("org-1", { coreDb, kv }, ctx))?.shardId).toBe(1)
	})

	it("writes nothing to KV and logs no reresolve when the primary names the shard it probed", async () => {
		const { primary } = await core([["org-1", 0]])
		const store = memoryKv()
		const writes = { delete: 0, put: 0 }
		const kv: ShardKv = {
			...store,
			delete: async (key) => ((writes.delete += 1), store.delete(key)),
			put: async (key, value, options) => ((writes.put += 1), store.put(key, value, options)),
		}
		const events: string[] = []
		const router = new ShardRouter({ log: (event) => void events.push(event), totalShards: 3 })
		await router.resolve("org-1", { coreDb: primary, kv }, ctx)
		await settle()
		const before = { ...writes }
		for (let i = 0; i < 3; i++) {
			const verified = await router.resolveVerified("org-1", { coreDb: primary, kv, present: async () => false }, ctx)
			expect(verified?.shardId).toBe(0)
		}
		await settle()
		expect(writes).toEqual(before)
		expect(events).not.toContain("shard-router.reresolve")
	})
})

describe("ShardRouter.place under this isolate's live tombstone (Q17)", () => {
	it("tags the revived mapping it puts, so another isolate trusts it without reading the primary", async () => {
		const { primary, replica } = await core([["org-1", 0]])
		const { coreDb, reads } = replicated(primary, replica)
		const kv = memoryKv()
		const router = new ShardRouter({ totalShards: 3 })
		await router.unplace("org-1", { coreDb, kv })
		await router.place({ orgId: "org-1", shardId: 2 }, { coreDb, kv }, ctx)
		await settle()
		const { nonce } = (await kv.get("shard-inv:org-1", "json")) as { nonce: string }
		expect(await kv.get("shard:org-1", "json")).toMatchObject({ shardId: 0, tag: nonce })
		reads.primary = 0
		expect((await new ShardRouter({ totalShards: 3 }).resolve("org-1", { coreDb, kv }, ctx))?.shardId).toBe(0)
		expect(reads.primary).toBe(0)
	})
})

describe("ShardRouter given no log (K15)", () => {
	it("warns on the console for each *.error event, and nothing else", async () => {
		const { primary } = await core([["org-1", 0]])
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const failing: ShardKv = {
			delete: async () => Promise.reject(new Error("KV down")),
			get: async () => Promise.reject(new Error("KV down")),
			put: async () => Promise.reject(new Error("KV down")),
		}
		await new ShardRouter({ totalShards: 3 }).resolve("org-1", { coreDb: primary, kv: failing }, ctx)
		await settle()
		expect(warn).toHaveBeenCalled()
		expect(warn.mock.calls.every(([event]) => String(event).endsWith(".error"))).toBe(true)
	})
})
