import type { D1Database, KVNamespace } from "@cloudflare/workers-types"
import { Miniflare } from "miniflare"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ShardRouter } from "./router.ts"
import type { ShardMapping } from "./types.ts"

/**
 * Minimal D1Database mock for testing.
 * ShardRouter uses drizzle(client) which calls prepare/bind/run — we mock at the D1 level.
 */
function mockD1(rows: Record<string, unknown>[] = []): D1Database {
	const stmt = {
		all: vi.fn().mockResolvedValue({ results: rows }),
		bind: vi.fn().mockReturnThis(),
		first: vi.fn().mockResolvedValue(rows[0] ?? null),
		raw: vi.fn().mockResolvedValue(rows),
		run: vi.fn().mockResolvedValue({ meta: {}, results: [], success: true }),
	}
	const session = {
		batch: vi.fn(),
		dump: vi.fn(),
		exec: vi.fn(),
		getBookmark: vi.fn().mockReturnValue("bk-test"),
		prepare: vi.fn().mockReturnValue(stmt),
		withSession: vi.fn(),
	}
	return {
		batch: vi.fn(),
		dump: vi.fn(),
		exec: vi.fn(),
		prepare: vi.fn().mockReturnValue(stmt),
		withSession: vi.fn().mockReturnValue(session),
	} as unknown as D1Database
}

function mockKV(data: Record<string, unknown> = {}): KVNamespace {
	return {
		delete: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockImplementation((key: string, _type: string) => {
			return Promise.resolve(data[key] ?? null)
		}),
		getWithMetadata: vi.fn(),
		list: vi.fn(),
		put: vi.fn().mockResolvedValue(undefined),
	} as unknown as KVNamespace
}

/* every waitUntil promise, so a test's background writes finish before its Miniflare is disposed */
const outstanding: Promise<unknown>[] = []

function mockWaitUntil(): {
	calls: Promise<unknown>[]
	ctx: { waitUntil: (p: Promise<unknown>) => void }
} {
	const calls: Promise<unknown>[] = []
	return {
		calls,
		ctx: {
			waitUntil: (p: Promise<unknown>) => {
				outstanding.push(p)
				calls.push(p)
			},
		},
	}
}

/** The mapping the KV tier hands back for org-1 */
const kvMapping: ShardMapping = {
	createdAt: 1000,
	deletedAt: null,
	driver: "d1",
	orgId: "org-1",
	shardId: 0,
	target: "0",
	updatedAt: 1000,
}

describe("ShardRouter", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("constructs with defaults", () => {
		const router = new ShardRouter({ totalShards: 4 })
		expect(router).toBeDefined()
	})

	it("constructs with custom config", () => {
		const log = vi.fn()
		const router = new ShardRouter({
			kvTtlSeconds: 120,
			log,
			lruHardTtlMs: 30 * 60 * 1000,
			lruMaxSize: 500,
			lruTtlMs: 10 * 60 * 1000,
			maxOrgsPerShard: 1000,
			totalShards: 8,
		})
		expect(router).toBeDefined()
	})

	it("getHandle returns D1 binding from env", () => {
		const router = new ShardRouter({ totalShards: 4 })
		const mockDb = {} as D1Database
		const mapping: ShardMapping = {
			createdAt: Date.now(),
			deletedAt: null,
			driver: "d1",
			orgId: "org-1",
			shardId: 0,
			target: "0",
			updatedAt: Date.now(),
		}
		const handle = router.getHandle(mapping, { SHARD_DB_0: mockDb })
		expect(handle.driver).toBe("d1")
		expect(handle.handle).toBe(mockDb)
	})

	it("getHandle throws for missing binding", () => {
		const router = new ShardRouter({ totalShards: 4 })
		const mapping: ShardMapping = {
			createdAt: Date.now(),
			deletedAt: null,
			driver: "d1",
			orgId: "org-1",
			shardId: 5,
			target: "5",
			updatedAt: Date.now(),
		}
		expect(() => router.getHandle(mapping, {})).toThrow("Missing D1 binding: SHARD_DB_5")
	})
})

describe("ShardRouter — resolve and invalidate", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("invalidate clears LRU and KV", async () => {
		const router = new ShardRouter({ totalShards: 4 })
		const kv = mockKV()
		await router.invalidate("org-1", kv)
		/* a tombstone for 3 × kvTtlSeconds, carrying the nonce a mapping must be tagged with while it lives */
		expect(kv.put).toHaveBeenCalledWith("shard-inv:org-1", expect.stringMatching(/^\{"nonce":"[0-9a-f-]{36}"\}$/), {
			expirationTtl: 180,
		})
	})

	it("resolve returns undefined when no mapping exists (KV miss, D1 miss)", async () => {
		const router = new ShardRouter({ totalShards: 4 })
		const d1 = mockD1([])
		const kv = mockKV()
		const { ctx } = mockWaitUntil()

		const result = await router.resolve("org-new", { coreDb: d1, kv }, ctx)
		expect(result).toBeUndefined()
	})

	it("resolve returns mapping from KV cache", async () => {
		const router = new ShardRouter({ totalShards: 4 })
		const d1 = mockD1()
		const kv = mockKV({ "shard:org-1": kvMapping })
		const { ctx } = mockWaitUntil()

		const result = await router.resolve("org-1", { coreDb: d1, kv }, ctx)
		expect(result).toEqual(kvMapping)
	})

	it("resolve returns stale LRU entry and triggers background revalidation", async () => {
		const router = new ShardRouter({
			lruHardTtlMs: 10_000,
			lruTtlMs: 1_000,
			totalShards: 4,
		})
		const d1 = mockD1()
		const kv = mockKV({ "shard:org-1": kvMapping })
		const { calls, ctx } = mockWaitUntil()

		/* Prime LRU via KV */
		await router.resolve("org-1", { coreDb: d1, kv }, ctx)

		/* Advance past soft TTL but before hard TTL */
		vi.advanceTimersByTime(1_500)

		const result = await router.resolve("org-1", { coreDb: d1, kv }, ctx)
		expect(result).toEqual(kvMapping)
		/* Background revalidation triggered */
		expect(calls.length).toBeGreaterThan(0)
	})
})

/* Allocation is SQL the core database runs (count, upsert, read-back), so it runs on D1 itself. */
const SHARD_MAP_DDL =
	"CREATE TABLE shard_map (created_at integer NOT NULL DEFAULT (unixepoch() * 1000), deleted_at integer, driver text NOT NULL DEFAULT 'd1', org_id text PRIMARY KEY, shard_id integer NOT NULL, target text NOT NULL, updated_at integer NOT NULL DEFAULT (unixepoch() * 1000))"

const WORKER = "export default { fetch() { return new Response(null, { status: 204 }) } }"

/* the Miniflare the running test started, disposed after it */
let mf: Miniflare | undefined

/** Settle the test's background writes, then dispose its Miniflare */
async function disposeMiniflare() {
	await Promise.allSettled(outstanding.splice(0))
	await mf?.dispose()
	mf = undefined
}

/** A core D1 holding `orgs` per shard ([count, shard]), and a KV namespace */
async function deps(counts: Array<[number, number]> = []) {
	mf = new Miniflare({ d1Databases: ["CORE"], kvNamespaces: ["KV"], modules: true, script: WORKER })
	const coreDb = (await mf.getD1Database("CORE")) as unknown as D1Database
	const kv = (await mf.getKVNamespace("KV")) as unknown as KVNamespace
	await coreDb.exec(SHARD_MAP_DDL)
	for (const [count, shard] of counts) {
		for (let i = 0; i < count; i++) {
			await coreDb
				.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES (?, ?, ?)")
				.bind(`seed-${shard}-${i}`, shard, String(shard))
				.run()
		}
	}
	return { coreDb, kv }
}

/** A core D1 with org-d1 mapped to shard 1, and a KV namespace */
async function seeded() {
	mf = new Miniflare({ d1Databases: ["CORE"], kvNamespaces: ["KV"], modules: true, script: WORKER })
	const coreDb = (await mf.getD1Database("CORE")) as unknown as D1Database
	const kv = (await mf.getKVNamespace("KV")) as unknown as KVNamespace
	await coreDb.exec(SHARD_MAP_DDL)
	await coreDb.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES ('org-d1', 1, '1')").run()
	return { coreDb, kv }
}

describe("ShardRouter — allocation", () => {
	afterEach(disposeMiniflare)

	it("places the first org on shard 0 when every shard is empty", async () => {
		const router = new ShardRouter({ maxOrgsPerShard: 10, totalShards: 4 })
		const { ctx } = mockWaitUntil()

		const mapping = await router.allocate("org-1", await deps(), ctx)

		expect(mapping).toMatchObject({ deletedAt: null, driver: "d1", orgId: "org-1", shardId: 0, target: "0" })
	})

	it("fills the shard with the most headroom, not simply the next one", async () => {
		const router = new ShardRouter({ maxOrgsPerShard: 10, totalShards: 3 })
		const { ctx } = mockWaitUntil()

		/* shard 1 is emptiest */
		const mapping = await router.allocate(
			"org-2",
			await deps([
				[9, 0],
				[2, 1],
				[8, 2],
			]),
			ctx,
		)

		expect(mapping.shardId).toBe(1)
	})

	it("refuses to over-fill rather than silently exceeding the cap", async () => {
		const router = new ShardRouter({ maxOrgsPerShard: 2, totalShards: 2 })
		const { ctx } = mockWaitUntil()
		const full = await deps([
			[2, 0],
			[2, 1],
		])

		await expect(router.allocate("org-3", full, ctx)).rejects.toMatchObject({ errorKey: "shards_full", status: 503 })
	})

	it("revives a soft-deleted org on its own shard, past the cap", async () => {
		const { ctx } = mockWaitUntil()
		const d = await deps([[2, 0]])
		await d.coreDb
			.prepare("INSERT INTO shard_map (org_id, shard_id, target, deleted_at) VALUES ('org-r', 0, '0', 1)")
			.run()

		const mapping = await new ShardRouter({ maxOrgsPerShard: 2, totalShards: 2 }).allocate("org-r", d, ctx)
		expect(mapping).toMatchObject({ deletedAt: null, shardId: 0 })
	})
})

describe("ShardRouter — allocation races and cache priming", () => {
	afterEach(disposeMiniflare)

	it("returns the mapping a racing router already wrote, not its own pick", async () => {
		const { ctx } = mockWaitUntil()
		const d = await deps()
		await d.coreDb.prepare("INSERT INTO shard_map (org_id, shard_id, target) VALUES ('org-4', 1, '1')").run()

		const mapping = await new ShardRouter({ totalShards: 2 }).allocate("org-4", d, ctx)
		expect(mapping).toMatchObject({ shardId: 1, target: "1" })
	})

	it("primes both cache tiers, deferring the KV write off the request path", async () => {
		const router = new ShardRouter({ totalShards: 2 })
		const { calls, ctx } = mockWaitUntil()
		const d = await deps()

		const mapping = await router.allocate("org-5", d, ctx)

		/* KV write is handed to waitUntil, not awaited inline */
		expect(calls.length).toBeGreaterThan(0)
		await Promise.all(calls)
		/* no tombstone fenced the write, so KV keeps the mapping untagged */
		expect(await d.kv.get("shard:org-5", "json")).toEqual(mapping)
		/* the LRU now answers without a new cache write */
		await router.resolve("org-5", d, ctx)
		expect(calls).toHaveLength(1)
	})

	it("resolveOrAllocate allocates only when nothing is mapped, and invalidate drops both tiers", async () => {
		const router = new ShardRouter({ totalShards: 2 })
		const { calls, ctx } = mockWaitUntil()
		const d = await deps()

		const first = await router.resolveOrAllocate("org-6", d, ctx)
		const second = await router.resolveOrAllocate("org-6", d, ctx)
		expect(second).toEqual(first)

		await Promise.all(calls)
		await router.invalidate("org-6", d.kv)
		expect(await d.kv.get("shard-inv:org-6", "json")).toEqual({ nonce: expect.any(String) })
	})
})

describe("ShardRouter — the core database tier", () => {
	afterEach(disposeMiniflare)

	it("resolves from the core database when both caches miss, and reports the tier", async () => {
		const events: string[] = []
		const router = new ShardRouter({
			log: (event, data) => events.push(`${event}:${String(data["tier"])}`),
			totalShards: 2,
		})
		const { calls, ctx } = mockWaitUntil()
		const d = await seeded()

		expect(await router.resolve("org-d1", d, ctx)).toMatchObject({ shardId: 1, target: "1" })
		expect(events).toEqual(["shard-router.hit:d1"])
		await Promise.all(calls)
		expect(await d.kv.get("shard:org-d1", "json")).toMatchObject({ shardId: 1 })
	})

	it("caches nothing it read from the core database when the org was invalidated during the read", async () => {
		const router = new ShardRouter({ totalShards: 2 })
		const { calls, ctx } = mockWaitUntil()
		const d = await seeded()
		const kv = {
			...d.kv,
			delete: (key: string) => d.kv.delete(key),
			get: async (key: string) => {
				await router.invalidate("org-d1", d.kv)
				return d.kv.get(key, "json")
			},
		} as unknown as typeof d.kv
		expect(await router.resolve("org-d1", { coreDb: d.coreDb, kv }, ctx)).toMatchObject({ shardId: 1 })
		await Promise.all(calls)
		expect(await d.kv.get("shard-inv:org-d1", "json")).toEqual({ nonce: expect.any(String) })
	})

	it("carries the session bookmark on what it allocates and what it reads, none when D1 has none", async () => {
		const d = await seeded()
		/* Miniflare's D1 has no withSession; a session over it reports a bookmark the way D1 does */
		const sessioned = (bookmark: string | null) => {
			const session = {
				batch: (statements: Parameters<D1Database["batch"]>[0]) => d.coreDb.batch(statements),
				getBookmark: () => bookmark,
				prepare: (query: string) => d.coreDb.prepare(query),
			}
			return { ...session, withSession: () => session } as unknown as D1Database
		}
		const { calls, ctx } = mockWaitUntil()

		const marked = { coreDb: sessioned("bk-test"), kv: d.kv }
		expect((await new ShardRouter({ totalShards: 2 }).resolve("org-d1", marked, ctx))?.d1Bookmark).toBe("bk-test")
		expect((await new ShardRouter({ totalShards: 2 }).allocate("org-new", marked, ctx)).d1Bookmark).toBe("bk-test")
		/* the first half cached org-d1 in KV; drop it so the next resolve reads the database again */
		await Promise.all(calls.splice(0))
		await d.kv.delete("shard:org-d1")
		const blank = { coreDb: sessioned(null), kv: d.kv }
		expect((await new ShardRouter({ totalShards: 2 }).resolve("org-d1", blank, ctx))?.d1Bookmark).toBeUndefined()
		expect((await new ShardRouter({ totalShards: 2 }).allocate("org-next", blank, ctx)).d1Bookmark).toBeUndefined()
		await Promise.all(calls)
	})
})

describe("ShardRouter — revalidation from the core database", () => {
	afterEach(disposeMiniflare)

	it("revalidates a stale entry from the core database once, however many requests see it", async () => {
		const router = new ShardRouter({ lruTtlMs: 1, totalShards: 2 })
		const { calls, ctx } = mockWaitUntil()
		const d = await seeded()
		await router.resolve("org-d1", d, ctx)
		await Promise.all(calls.splice(0))
		await d.kv.delete("shard:org-d1")
		await new Promise((resolve) => setTimeout(resolve, 5))

		await Promise.all([router.resolve("org-d1", d, ctx), router.resolve("org-d1", d, ctx)])
		expect(calls).toHaveLength(1)
		await Promise.all(calls)
		expect(await d.kv.get("shard:org-d1", "json")).toMatchObject({ shardId: 1 })
	})

	it("stops routing an org once revalidation finds it soft-deleted, before the hard TTL (Q-S1)", async () => {
		const router = new ShardRouter({ lruHardTtlMs: 60_000, lruTtlMs: 1, totalShards: 2 })
		const { calls, ctx } = mockWaitUntil()
		const d = await seeded()
		await router.resolve("org-d1", d, ctx)
		await Promise.all(calls.splice(0))
		await d.kv.delete("shard:org-d1")
		await d.coreDb.prepare("UPDATE shard_map SET deleted_at = 1").run()
		await new Promise((resolve) => setTimeout(resolve, 5))

		/* the stale entry still answers once, and its revalidation finds no live row */
		expect(await router.resolve("org-d1", d, ctx)).toMatchObject({ shardId: 1 })
		await Promise.all(calls.splice(0))
		expect(await router.resolve("org-d1", d, ctx)).toBeUndefined()
		expect(await d.kv.get("shard-inv:org-d1", "json")).toEqual({ nonce: expect.any(String) })
	})
})

/** A KV whose next get waits until `release` hands it the old mapping */
function slowKv() {
	const pending: Array<(value: unknown) => void> = []
	const kv = mockKV()
	vi.mocked(kv.get).mockImplementationOnce((() => new Promise((resolve) => pending.push(resolve))) as never)
	return { kv, release: (value: unknown) => pending.shift()?.(value) }
}

describe("ShardRouter — an invalidate while a read is in flight (E-N2)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("drops a revalidation's write when the org was invalidated meanwhile", async () => {
		const router = new ShardRouter({ lruHardTtlMs: 10_000, lruTtlMs: 1_000, totalShards: 4 })
		const { calls, ctx } = mockWaitUntil()
		await router.resolve("org-1", { coreDb: mockD1(), kv: mockKV({ "shard:org-1": kvMapping }) }, ctx)
		vi.advanceTimersByTime(1_500)
		const { kv, release } = slowKv()
		await router.resolve("org-1", { coreDb: mockD1(), kv }, ctx)
		await router.invalidate("org-1", kv)
		release(kvMapping)
		await Promise.all(calls)
		expect(await router.resolve("org-1", { coreDb: mockD1([]), kv: mockKV() }, ctx)).toBeUndefined()
	})

	it("drops a revalidation's core read when the org was invalidated during it, evicting nothing", async () => {
		const router = new ShardRouter({ lruHardTtlMs: 10_000, lruTtlMs: 1_000, totalShards: 4 })
		const { calls, ctx } = mockWaitUntil()
		await router.resolve("org-1", { coreDb: mockD1(), kv: mockKV({ "shard:org-1": kvMapping }) }, ctx)
		vi.advanceTimersByTime(1_500)
		const { kv, release } = slowKv()
		await router.resolve("org-1", { coreDb: mockD1([]), kv }, ctx)
		release(null)
		await router.invalidate("org-1", kv)
		await Promise.all(calls)
		/* the invalidate's tombstone and delete are the only writes: the outdated revalidation evicts nothing */
		expect(kv.put).toHaveBeenCalledTimes(1)
		expect(kv.delete).toHaveBeenCalledTimes(1)
	})

	it("drops a resolve's cache write when the org was invalidated during its KV read", async () => {
		const router = new ShardRouter({ totalShards: 4 })
		const { ctx } = mockWaitUntil()
		const { kv, release } = slowKv()
		const resolving = router.resolve("org-1", { coreDb: mockD1(), kv }, ctx)
		await router.invalidate("org-1", kv)
		release(kvMapping)
		/* an entry read across this isolate's own invalidate is no hit: the core read finds nothing, and nothing is cached */
		expect(await resolving).toBeUndefined()
		expect(await router.resolve("org-1", { coreDb: mockD1([]), kv: mockKV() }, ctx)).toBeUndefined()
	})
})
