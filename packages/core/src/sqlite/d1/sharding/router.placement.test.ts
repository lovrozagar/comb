/**
 * R2 of the 0.12 consumers review: placement the app decides, an org placed or moved by hand, a
 * mapping that is verified on use across isolates, and a replica that lags a fresh placement.
 */
import type { D1Database } from "@cloudflare/workers-types"
import { Miniflare } from "miniflare"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ShardRouter } from "./router.ts"
import type { ShardKv } from "./types.ts"

const SHARD_MAP_DDL =
	"CREATE TABLE shard_map (created_at integer NOT NULL DEFAULT (unixepoch() * 1000), deleted_at integer, driver text NOT NULL DEFAULT 'd1', org_id text PRIMARY KEY, shard_id integer NOT NULL, target text NOT NULL, updated_at integer NOT NULL DEFAULT (unixepoch() * 1000))"
const WORKER = "export default { fetch() { return new Response(null, { status: 204 }) } }"

let mf: Miniflare | undefined
const outstanding: Promise<unknown>[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => void outstanding.push(p) }
afterEach(async () => {
	await Promise.allSettled(outstanding.splice(0))
	await mf?.dispose()
	mf = undefined
})

/** A KV that keeps what it is given */
function memoryKv(): ShardKv {
	const store = new Map<string, string>()
	return {
		delete: async (key) => void store.delete(key),
		get: async (key) => (store.has(key) ? JSON.parse(store.get(key) as string) : null),
		put: async (key, value) => void store.set(key, value),
	}
}

/**
 * A core database whose primary is `primary` and whose replica is `replica`, as D1 sessions reach
 * them: a `first-unconstrained` session reads the replica, any other the primary; each read counted
 */
function replicated(primary: D1Database, replica: D1Database) {
	const reads = { primary: 0, replica: 0 }
	const sessionOf = (db: D1Database, tier: keyof typeof reads) => ({
		batch: (statements: unknown) => db.batch(statements as never),
		getBookmark: () => "bk",
		prepare: (query: string) => {
			reads[tier]++
			return db.prepare(query)
		},
	})
	const coreDb = {
		prepare: (query: string) => primary.prepare(query),
		withSession: (constraint: string) =>
			constraint === "first-unconstrained" ? sessionOf(replica, "replica") : sessionOf(primary, "primary"),
	} as unknown as D1Database
	return { coreDb, reads }
}

/** A core database with `rows` ([org, shard]) in shard_map, and one more for a lagging replica */
async function core(rows: Array<[string, number]> = []) {
	mf = new Miniflare({ d1Databases: ["CORE", "LAG"], kvNamespaces: ["KV"], modules: true, script: WORKER })
	const primary = (await mf.getD1Database("CORE")) as unknown as D1Database
	const replica = (await mf.getD1Database("LAG")) as unknown as D1Database
	for (const db of [primary, replica]) await db.exec(SHARD_MAP_DDL)
	for (const [org, shard] of rows)
		await primary
			.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES (?, ?, ?)")
			.bind(org, shard, String(shard))
			.run()
	return { primary, replica }
}

describe("ShardRouter: a placement the app decides", () => {
	it("asks pick for the shard, with the org and each shard's live count, and refuses when it names none", async () => {
		const { primary } = await core([["seed", 1]])
		const pick = vi.fn(({ counts }: { counts: ReadonlyMap<number, number> }) => (counts.get(1) === 1 ? 2 : undefined))
		const router = new ShardRouter({ pick, totalShards: 3 })
		const mapping = await router.allocate("org-1", { coreDb: primary, kv: memoryKv() }, ctx)
		expect(mapping.shardId).toBe(2)
		expect(pick).toHaveBeenCalledWith({ counts: new Map([[1, 1]]), orgId: "org-1", totalShards: 3 })
		const refusing = new ShardRouter({ pick: () => undefined, totalShards: 3 })
		await expect(refusing.allocate("org-2", { coreDb: primary, kv: memoryKv() }, ctx)).rejects.toMatchObject({
			errorKey: "shards_full",
		})
	})
})

describe("ShardRouter: place, move and unplace", () => {
	it("places an org on a shard, the first writer winning: two places of one new org agree", async () => {
		const { primary } = await core()
		const deps = { coreDb: primary, kv: memoryKv() }
		const [a, b] = await Promise.all([
			new ShardRouter({ totalShards: 3 }).place({ orgId: "org-1", shardId: 0 }, deps, ctx),
			new ShardRouter({ totalShards: 3 }).place({ orgId: "org-1", shardId: 2 }, deps, ctx),
		])
		expect(a.shardId).toBe(b.shardId)
		expect(
			(await new ShardRouter({ totalShards: 3 }).resolve("org-1", { coreDb: primary, kv: memoryKv() }, ctx))?.shardId,
		).toBe(a.shardId)
	})

	it("revives a soft-deleted org where it is placed, and moves one by overwriting", async () => {
		const { primary } = await core([["org-1", 0]])
		const router = new ShardRouter({ totalShards: 3 })
		const deps = { coreDb: primary, kv: memoryKv() }
		await router.unplace("org-1", deps)
		expect(await router.resolve("org-1", deps, ctx)).toBeUndefined()
		expect((await router.place({ orgId: "org-1", shardId: 1 }, deps, ctx)).shardId).toBe(0)
		expect((await router.move({ orgId: "org-1", shardId: 2 }, deps, ctx)).shardId).toBe(2)
		expect((await router.resolve("org-1", deps, ctx))?.shardId).toBe(2)
	})
})

describe("ShardRouter: a mapping verified on use", () => {
	it("re-resolves from the primary, uncached, when the org is absent from its cached shard", async () => {
		const { primary } = await core([["org-1", 0]])
		const deps = { coreDb: primary, kv: memoryKv() }
		const stale = new ShardRouter({ totalShards: 3 })
		expect((await stale.resolve("org-1", deps, ctx))?.shardId).toBe(0)
		/* another isolate moves the org; this one's LRU still says 0 */
		await new ShardRouter({ totalShards: 3 }).move(
			{ orgId: "org-1", shardId: 2 },
			{ coreDb: primary, kv: memoryKv() },
			ctx,
		)
		const present = vi.fn(async (handle: { shardId: number }) => handle.shardId === 2)
		const mapping = await stale.resolveVerified("org-1", { ...deps, present }, ctx)
		expect(mapping?.shardId).toBe(2)
		expect(present).toHaveBeenCalledTimes(1)
	})

	it("probes once when the primary names the shard it just probed: the org's rows may not be there yet", async () => {
		const { primary } = await core([["org-1", 0]])
		const present = vi.fn(async () => false)
		const mapping = await new ShardRouter({ totalShards: 3 }).resolveVerified(
			"org-1",
			{ coreDb: primary, kv: memoryKv(), present },
			ctx,
		)
		expect(mapping?.shardId).toBe(0)
		expect(present).toHaveBeenCalledTimes(1)
	})

	it("answers nothing for an org unplaced since", async () => {
		const { primary } = await core([["org-1", 0]])
		const deps = { coreDb: primary, kv: memoryKv() }
		const router = new ShardRouter({ totalShards: 3 })
		await router.resolve("org-1", deps, ctx)
		await new ShardRouter({ totalShards: 3 }).unplace("org-1", { coreDb: primary, kv: memoryKv() })
		expect(await router.resolveVerified("org-1", { ...deps, present: async () => false }, ctx)).toBeUndefined()
	})
})

describe("ShardRouter: a replica that lags a fresh placement", () => {
	it("reads the primary when the replica misses, and caches the miss briefly so an unknown id cannot load it", async () => {
		const { primary, replica } = await core([["org-1", 1]])
		const { coreDb, reads } = replicated(primary, replica)
		const router = new ShardRouter({ totalShards: 3 })
		expect((await router.resolve("org-1", { coreDb, kv: memoryKv() }, ctx))?.shardId).toBe(1)
		const before = reads.primary
		for (let i = 0; i < 5; i++) expect(await router.resolve("nobody", { coreDb, kv: memoryKv() }, ctx)).toBeUndefined()
		expect(reads.primary - before).toBe(1)
	})

	it("forgets a cached miss once the org is placed", async () => {
		const { primary, replica } = await core()
		const { coreDb } = replicated(primary, replica)
		const deps = { coreDb, kv: memoryKv() }
		const router = new ShardRouter({ totalShards: 3 })
		expect(await router.resolve("org-1", deps, ctx)).toBeUndefined()
		await router.place({ orgId: "org-1", shardId: 1 }, deps, ctx)
		expect((await router.resolve("org-1", deps, ctx))?.shardId).toBe(1)
	})
})

/** A KV that keeps nothing, so every read past the LRU goes to the core database */
const noKv: ShardKv = { delete: async () => {}, get: async () => null, put: async () => {} }

describe("ShardRouter: placement edges", () => {
	it("refuses a shard that is not one of the router's, whether the app names it or pick does", async () => {
		const { primary } = await core()
		const deps = { coreDb: primary, kv: memoryKv() }
		const router = new ShardRouter({ totalShards: 3 })
		for (const shardId of [3, -1, 1.5]) {
			await expect(router.place({ orgId: "org-1", shardId }, deps, ctx)).rejects.toThrow(RangeError)
			await expect(router.move({ orgId: "org-1", shardId }, deps, ctx)).rejects.toThrow(RangeError)
		}
		const wild = new ShardRouter({ pick: async () => 3, totalShards: 3 })
		await expect(wild.allocate("org-1", deps, ctx)).rejects.toThrow("Shard 3 is not one of the 3 shards")
	})

	it("logs a placement, a revival, a move and a re-resolve", async () => {
		const { primary } = await core()
		const log = vi.fn()
		const deps = { coreDb: primary, kv: memoryKv() }
		const router = new ShardRouter({ log, totalShards: 3 })
		await router.place({ orgId: "org-1", shardId: 1 }, deps, ctx)
		await router.unplace("org-1", deps)
		await router.place({ orgId: "org-1", shardId: 2 }, deps, ctx)
		await router.move({ orgId: "org-1", shardId: 0 }, deps, ctx)
		await new ShardRouter({ totalShards: 3 }).move({ orgId: "org-1", shardId: 2 }, { coreDb: primary, kv: noKv }, ctx)
		await router.resolveVerified("org-1", { ...deps, kv: noKv, present: async () => false }, ctx)
		const events = log.mock.calls.filter(([event]) => event !== "shard-router.hit" && event !== "shard-router.miss")
		expect(events).toEqual([
			["shard-router.allocate", { orgId: "org-1", shardId: 1 }],
			["shard-router.allocate", { orgId: "org-1", revived: true, shardId: 1 }],
			["shard-router.move", { orgId: "org-1", shardId: 0 }],
			["shard-router.reresolve", { from: 0, orgId: "org-1", to: 2 }],
		])
	})

	it("probes nothing for an org that has no mapping", async () => {
		const { primary } = await core()
		const present = vi.fn(async () => true)
		const router = new ShardRouter({ totalShards: 3 })
		expect(await router.resolveVerified("nobody", { coreDb: primary, kv: memoryKv(), present }, ctx)).toBeUndefined()
		expect(present).not.toHaveBeenCalled()
	})
})

describe("ShardRouter: the cached miss", () => {
	it("reads the primary again once missTtlMs has passed", async () => {
		const { primary, replica } = await core()
		const { coreDb, reads } = replicated(primary, replica)
		const router = new ShardRouter({ missTtlMs: 1, totalShards: 3 })
		await router.resolve("nobody", { coreDb, kv: noKv }, ctx)
		await new Promise((resolve) => setTimeout(resolve, 5))
		await router.resolve("nobody", { coreDb, kv: noKv }, ctx)
		expect(reads.primary).toBe(2)
	})

	it("is not kept when the org was invalidated while it was read", async () => {
		const { primary, replica } = await core()
		const { coreDb, reads } = replicated(primary, replica)
		const router = new ShardRouter({ totalShards: 3 })
		const racing: ShardKv = { ...noKv, get: async () => (await router.invalidate("nobody", noKv), null) }
		await router.resolve("nobody", { coreDb, kv: racing }, ctx)
		await router.resolve("nobody", { coreDb, kv: noKv }, ctx)
		expect(reads.primary).toBe(2)
	})

	it("keeps a stale entry whose revalidation finds it on the primary only", async () => {
		const { primary, replica } = await core([["org-1", 1]])
		const { coreDb } = replicated(primary, replica)
		const log = vi.fn()
		const router = new ShardRouter({ log, lruTtlMs: 1, totalShards: 3 })
		await router.resolve("org-1", { coreDb, kv: noKv }, ctx)
		await new Promise((resolve) => setTimeout(resolve, 5))
		await router.resolve("org-1", { coreDb, kv: noKv }, ctx)
		await Promise.all(outstanding.splice(0))
		log.mockClear()
		expect((await router.resolve("org-1", { coreDb, kv: noKv }, ctx))?.shardId).toBe(1)
		expect(log).toHaveBeenCalledWith("shard-router.hit", { orgId: "org-1", stale: false, tier: "lru" })
	})
})

/* the 3.5 review: an unplace landing between place's insert, revive and read-back returned a deleted row */
describe("ShardRouter: place in one transaction", () => {
	it("sends its insert, its revive and its read-back as one D1 batch", async () => {
		const { primary } = await core([["org-1", 0]])
		const batch = vi.fn((statements: unknown) => primary.batch(statements as never))
		const coreDb = { batch, prepare: (query: string) => primary.prepare(query) } as unknown as D1Database
		const router = new ShardRouter({ totalShards: 3 })
		await router.unplace("org-1", { coreDb: primary, kv: noKv })
		expect((await router.place({ orgId: "org-1", shardId: 2 }, { coreDb, kv: noKv }, ctx)).shardId).toBe(0)
		expect(batch).toHaveBeenCalledTimes(1)
		expect(batch.mock.calls[0]?.[0]).toHaveLength(3)
	})
})

/* U34: KV is a cache, so a KV that fails is a miss, and a write that committed in D1 does not throw for it */
describe("ShardRouter: a KV that fails", () => {
	const broken: ShardKv = {
		delete: () => Promise.reject(new Error("kv down")),
		get: () => Promise.reject(new Error("kv down")),
		put: () => Promise.reject(new Error("kv down")),
	}

	it("resolves from the core table, logging the failure, and moves, unplaces and invalidates without throwing", async () => {
		const { primary } = await core([["org-1", 1]])
		const log = vi.fn()
		const router = new ShardRouter({ log, totalShards: 3 })
		const deps = { coreDb: primary, kv: broken }
		expect((await router.resolve("org-1", deps, ctx))?.shardId).toBe(1)
		await Promise.all(outstanding.splice(0))
		expect(log).toHaveBeenCalledWith("shard-router.kv.error", expect.objectContaining({ orgId: "org-1" }))
		expect((await router.move({ orgId: "org-1", shardId: 2 }, deps, ctx)).shardId).toBe(2)
		await expect(router.unplace("org-1", deps)).resolves.toBeUndefined()
		await expect(router.invalidate("org-1", broken)).resolves.toBeUndefined()
		await Promise.all(outstanding.splice(0))
	})

	it("logs a revalidation whose core read then fails, instead of throwing it into waitUntil", async () => {
		const { primary } = await core([["org-1", 1]])
		const events: string[] = []
		const router = new ShardRouter({ log: (event) => events.push(event), lruTtlMs: 1, totalShards: 3 })
		await router.resolve("org-1", { coreDb: primary, kv: broken }, ctx)
		await Promise.all(outstanding.splice(0))
		await new Promise((resolve) => setTimeout(resolve, 5))
		const down = {
			withSession: () => {
				throw new Error("d1 down")
			},
		} as unknown as D1Database
		expect((await router.resolve("org-1", { coreDb: down, kv: broken }, ctx))?.shardId).toBe(1)
		await Promise.all(outstanding.splice(0))
		expect(events.slice(-2)).toEqual(["shard-router.kv.error", "shard-router.revalidate.error"])
	})
})

/** The allocations `log` was told of */
const allocations = (log: ReturnType<typeof vi.fn>) =>
	log.mock.calls.filter(([event]) => event === "shard-router.allocate")

/* U40: shard-router.allocate counts the rows a placement wrote, so a metric on it does not overcount */
describe("ShardRouter: an allocation logged only when it wrote a row", () => {
	it("logs nothing for a place or an allocate of an org already placed", async () => {
		const { primary } = await core()
		const log = vi.fn()
		const deps = { coreDb: primary, kv: memoryKv() }
		const router = new ShardRouter({ log, totalShards: 3 })
		await router.place({ orgId: "org-1", shardId: 1 }, deps, ctx)
		expect((await router.place({ orgId: "org-1", shardId: 2 }, deps, ctx)).shardId).toBe(1)
		expect((await router.allocate("org-1", deps, ctx)).shardId).toBe(1)
		expect(allocations(log)).toEqual([["shard-router.allocate", { orgId: "org-1", shardId: 1 }]])
	})

	it("logs one allocation when two isolates allocate one new org at once", async () => {
		const { primary } = await core()
		const log = vi.fn()
		const deps = { coreDb: primary, kv: memoryKv() }
		const [a, b] = await Promise.all([
			new ShardRouter({ log, totalShards: 3 }).allocate("org-1", deps, ctx),
			new ShardRouter({ log, totalShards: 3 }).allocate("org-1", deps, ctx),
		])
		expect(a.shardId).toBe(b.shardId)
		expect(allocations(log)).toHaveLength(1)
	})
})
