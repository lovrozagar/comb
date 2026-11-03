import type { D1DatabaseLike, D1StatementLike } from "../d1-types.ts"

type ShardDriver = "d1"

type ShardMapping = {
	createdAt: number
	deletedAt: number | null
	driver: ShardDriver
	orgId: string
	shardId: number
	target: string
	updatedAt: number
}

/** A shard's binding, in the type getHandle reads from the env it is passed */
type ShardDbHandle<D extends D1DatabaseLike = D1DatabaseLike> = { driver: "d1"; handle: D }

/**
 * The binding getHandle hands back for an env of type `E` (K2 of r22): the type its `SHARD_DB_*`
 * keys hold, as `wrangler types` writes them; an env with a string index signature names no
 * binding's type, and gives the structural D1DatabaseLike
 */
type ShardBindingOf<E> = string extends keyof E
	? D1DatabaseLike
	: Extract<E[Extract<keyof E, `SHARD_DB_${string}`>], D1DatabaseLike>

/**
 * What getHandle asks of an env of type `E` beyond `E` itself: each `SHARD_DB_*` key holds a D1
 * binding, and an env whose known keys hold no such key is refused, naming the key it lacks
 */
type ShardEnv<E> = string extends keyof E
	? unknown
	: [Extract<keyof E, `SHARD_DB_${string}`>] extends [never]
		? { "SHARD_DB_<target>": D1DatabaseLike }
		: Record<Extract<keyof E, `SHARD_DB_${string}`>, D1DatabaseLike>

/**
 * The KV the router caches mappings in: the three calls it makes. Structural, so a Worker's global
 * `KVNamespace` and the one `@cloudflare/workers-types` exports both fit; the two are distinct types.
 */
type ShardKv = {
	delete(key: string): Promise<void>
	get(key: string, type: "json"): Promise<unknown>
	put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

type ShardResolverDeps = {
	coreDb: D1DatabaseLike
	kv: ShardKv
}

/** What `pick` is told about a new org: how many live orgs each D1 shard holds, absent when none */
type ShardPickInput = { counts: ReadonlyMap<number, number>; orgId: string; totalShards: number }

/** The shard a new org goes to, or undefined when none should take it (`shards_full`) */
type ShardPick = (input: ShardPickInput) => number | undefined | Promise<number | undefined>

/** Structural type so both `@cloudflare/workers-types` and `cloudflare:workers` satisfy it */
type WaitUntilCtx = { waitUntil: (promise: Promise<unknown>) => void }

/** Pluggable logger — defaults to no-op */
type LogFn = (event: string, data: Record<string, unknown>) => void

/** An org and the shard to put it on */
type ShardPlacement = { orgId: string; shardId: number }

/** A move: the placement, and the app's own statements on the core database to batch with it (R4) */
type ShardMove = ShardPlacement & { with?: readonly D1StatementLike[] | undefined }

/** The deps of `resolveVerified`: those of `resolve`, and how the app checks an org's rows are on the shard a mapping names */
type ShardVerifyDeps = ShardResolverDeps & { present: (mapping: ShardMapping) => Promise<boolean> }

interface ShardRouterConfig {
	kvTtlSeconds?: number
	log?: LogFn
	lruHardTtlMs?: number
	lruMaxSize?: number
	lruTtlMs?: number
	maxOrgsPerShard?: number
	/** How long this isolate remembers that the primary has no mapping for an org */
	missTtlMs?: number
	/** The shard a new org goes to; the default takes the one with the most headroom under maxOrgsPerShard */
	pick?: ShardPick
	totalShards: number
}

export type {
	LogFn,
	ShardBindingOf,
	ShardDbHandle,
	ShardDriver,
	ShardEnv,
	ShardKv,
	ShardMapping,
	ShardMove,
	ShardPick,
	ShardPickInput,
	ShardPlacement,
	ShardResolverDeps,
	ShardRouterConfig,
	ShardVerifyDeps,
	WaitUntilCtx,
}
