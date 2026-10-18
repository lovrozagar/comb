import type { D1Database } from "@cloudflare/workers-types"
type ShardDriver = "d1"

type ShardMapping = {
	createdAt: number
	d1Bookmark?: string | undefined
	deletedAt: number | null
	driver: ShardDriver
	orgId: string
	shardId: number
	target: string
	updatedAt: number
}

type ShardDbHandle = { driver: "d1"; handle: D1Database }

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
	coreDb: D1Database
	kv: ShardKv
}

export type { ShardDbHandle, ShardDriver, ShardKv, ShardMapping, ShardResolverDeps }
