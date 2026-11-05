import type { D1DatabaseLike, D1StatementLike } from "../d1-types.ts"

/** The kind of database a shard is; Cloudflare D1 is the only one */
type ShardDriver = "d1"

/** Where an org's rows live: its `shard_map` row, as the router reads and caches it */
type ShardMapping = {
	/** when the org was first placed, in epoch milliseconds */
	createdAt: number
	/** when the org was unplaced, in epoch milliseconds; null while its mapping is live */
	deletedAt: number | null
	/** the kind of database the shard is */
	driver: ShardDriver
	/** the org's id, at most 64 UTF-16 code units */
	orgId: string
	/** the shard the org's rows are on, from 0 up to `totalShards - 1` */
	shardId: number
	/** the suffix of the env binding getHandle opens, `SHARD_DB_<target>`; comb writes it as String(shardId) */
	target: string
	/** when the mapping last changed, in epoch milliseconds */
	updatedAt: number
}

/** A shard's binding, in the type getHandle reads from the env it is passed */
type ShardDbHandle<D extends D1DatabaseLike = D1DatabaseLike> = {
	/** the kind of database `handle` is */
	driver: "d1"
	/** the shard's D1 binding, taken from the env as it is */
	handle: D
}

/**
 * The binding getHandle hands back for an env of type `E`: the type its `SHARD_DB_*` keys hold,
 * as `wrangler types` writes them, a key bound in only some environments among them; an env with
 * a string index signature gives the D1 binding its index holds, and the structural
 * D1DatabaseLike when it holds none
 */
type ShardBindingOf<E> = string extends keyof E
	? Extract<NonNullable<E[string & keyof E]>, D1DatabaseLike> extends infer D extends D1DatabaseLike
		? [D] extends [never]
			? D1DatabaseLike
			: D
		: never
	: Extract<NonNullable<E[Extract<keyof E, `SHARD_DB_${string}`>]>, D1DatabaseLike>

/**
 * What getHandle asks of an env of type `E` beyond `E` itself: each `SHARD_DB_*` key holds a D1
 * binding, and an env whose known keys hold no such key is refused, naming the key it lacks. A key
 * may be optional, as `wrangler types` writes one bound in only some environments: getHandle
 * throws on an absent one at run time. An env with a string index signature is taken when its
 * index may hold a D1 binding, and refused when it provably holds none
 */
type ShardEnv<E> = string extends keyof E
	? unknown extends E[string & keyof E]
		? unknown
		: [Extract<NonNullable<E[string & keyof E]>, D1DatabaseLike>] extends [never]
			? {
					/** the key the env lacks: a D1 binding for each shard, `SHARD_DB_0` upward; it names the fault in the type error and no env holds it */
					"SHARD_DB_<target>": D1DatabaseLike
				}
			: unknown
	: [Extract<keyof E, `SHARD_DB_${string}`>] extends [never]
		? {
				/** the key the env lacks: a D1 binding for each shard, `SHARD_DB_0` upward; it names the fault in the type error and no env holds it */
				"SHARD_DB_<target>": D1DatabaseLike
			}
		: { [K in Extract<keyof E, `SHARD_DB_${string}`>]?: D1DatabaseLike | undefined }

/**
 * The KV the router caches mappings in: the three calls it makes. Structural, so a Worker's global
 * `KVNamespace` and the one `@cloudflare/workers-types` exports both fit; the two are distinct types.
 */
type ShardKv = {
	/** Remove `key`; the router drops an org's cached mapping this way when it invalidates the org */
	delete(key: string): Promise<void>
	/** The JSON value stored under `key`, parsed, or null when none is */
	get(key: string, type: "json"): Promise<unknown>
	/** Store `value`, a JSON text, under `key` */
	put(
		key: string,
		value: string,
		options?: {
			/** seconds until the key expires: `kvTtlSeconds` for a mapping, never under KV's 60-second floor */
			expirationTtl?: number | undefined
		},
	): Promise<void>
}

/** The bindings a lookup or a write reads, passed per request since a Worker gets them from its env */
type ShardResolverDeps = {
	/** the core D1 database holding `shard_map`: reads go to the nearest replica, writes to the primary */
	coreDb: D1DatabaseLike
	/** the KV namespace mappings are cached in, under `shard:<orgId>`, for `kvTtlSeconds` */
	kv: ShardKv
}

/** What `pick` is told about a new org: how many live orgs each D1 shard holds, absent when none */
type ShardPickInput = {
	/** each shard's live orgs, by shard id; a shard holding none has no entry */
	counts: ReadonlyMap<number, number>
	/** the org being placed */
	orgId: string
	/** the router's shard count: a pick answers a shard from 0 up to `totalShards - 1`, or a RangeError is thrown */
	totalShards: number
}

/** The shard a new org goes to, or undefined when none should take it (`shards_full`) */
type ShardPick = (input: ShardPickInput) => number | undefined | Promise<number | undefined>

/** Structural type so both `@cloudflare/workers-types` and `cloudflare:workers` satisfy it */
type WaitUntilCtx = {
	/** Keep the Worker alive until `promise` settles; the router hands it KV writes and background revalidation */
	waitUntil: (promise: Promise<unknown>) => void
}

/** A logger for the router's events: the event's name, such as `shard-router.miss`, and its data */
type LogFn = (event: string, data: Record<string, unknown>) => void

/** An org and the shard to put it on */
type ShardPlacement = {
	/** the org, at most 64 UTF-16 code units, or a RangeError is thrown */
	orgId: string
	/** the shard, from 0 up to `totalShards - 1`, or a RangeError is thrown */
	shardId: number
}

/** A move: the placement, and the app's own statements on the core database to batch with it */
type ShardMove = ShardPlacement & {
	/** statements on the core database run in one batch after the mapping's write, landing with it or not at all */
	with?: readonly D1StatementLike[] | undefined
}

/** The deps of `resolveVerified`: those of `resolve`, and how the app checks an org's rows are on the shard a mapping names */
type ShardVerifyDeps = ShardResolverDeps & {
	/** Whether the org's rows are on the shard `mapping` names, as the app checks it, such as by reading one row there */
	present: (mapping: ShardMapping) => Promise<boolean>
}

/** A ShardRouter's settings; the constructor throws a RangeError on one it cannot run on */
interface ShardRouterConfig {
	/** Seconds a mapping stays in KV, an integer of at least 60, KV's floor; 60 when omitted */
	kvTtlSeconds?: number | undefined
	/** Where the router's events go, such as `shard-router.hit`, `shard-router.allocate` and `shard-router.kv.error`; when omitted, each `*.error` event, a failure the router absorbed, goes to console.warn and the rest are dropped */
	log?: LogFn | undefined
	/** Milliseconds a mapping stays in this isolate's memory at all; 900000 (15 minutes) when omitted */
	lruHardTtlMs?: number | undefined
	/** The most orgs this isolate keeps in memory, the least recently used dropped first; 1000 when omitted */
	lruMaxSize?: number | undefined
	/** Milliseconds a mapping in memory is served fresh; after it, served stale while one background read refreshes it; 300000 (5 minutes) when omitted */
	lruTtlMs?: number | undefined
	/** The live orgs the default `pick` puts on one shard, a positive integer; 500 when omitted. A soft cap: two allocations at once can both take a shard's last place */
	maxOrgsPerShard?: number | undefined
	/** How long this isolate remembers that the primary has no mapping for an org, in milliseconds; 5000 when omitted */
	missTtlMs?: number | undefined
	/** The shard a new org goes to; the default takes the one with the most headroom under maxOrgsPerShard */
	pick?: ShardPick | undefined
	/** How many shards there are, a positive integer: shards 0 up to `totalShards - 1`, each bound as `SHARD_DB_<n>` */
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
