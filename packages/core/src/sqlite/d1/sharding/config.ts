/**
 * The router's settings, checked when it is built (U39): a shard count or a cap that is no
 * positive integer would answer every allocation `shards_full`, a config error reported as
 * capacity, and a KV TTL under KV's 60-second floor fails every put, so KV would cache nothing.
 */
import type { ShardRouterConfig } from "./types.ts"

const DEFAULTS = {
	kvTtlSeconds: 60,
	/* 15 minutes */
	lruHardTtlMs: 900_000,
	lruMaxSize: 1000,
	/* 5 minutes */
	lruTtlMs: 300_000,
	maxOrgsPerShard: 500,
	missTtlMs: 5000,
} as const

/* KV refuses an expirationTtl under 60 seconds */
const KV_MIN_TTL_SECONDS = 60

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0

/** `config`'s settings with the defaults filled in; a RangeError for one the router cannot run on */
function routerSettings(config: ShardRouterConfig): {
	kvTtlSeconds: number
	maxOrgsPerShard: number
	totalShards: number
} {
	const { kvTtlSeconds = DEFAULTS.kvTtlSeconds, maxOrgsPerShard = DEFAULTS.maxOrgsPerShard, totalShards } = config
	if (!isPositiveInteger(totalShards))
		throw new RangeError(`totalShards must be a positive integer, got ${totalShards}`)
	if (!isPositiveInteger(maxOrgsPerShard))
		throw new RangeError(`maxOrgsPerShard must be a positive integer, got ${maxOrgsPerShard}`)
	if (!Number.isSafeInteger(kvTtlSeconds) || kvTtlSeconds < KV_MIN_TTL_SECONDS)
		throw new RangeError(
			`kvTtlSeconds must be an integer of at least ${KV_MIN_TTL_SECONDS}, KV's floor, got ${kvTtlSeconds}`,
		)
	return { kvTtlSeconds, maxOrgsPerShard, totalShards }
}

export { DEFAULTS, routerSettings }
