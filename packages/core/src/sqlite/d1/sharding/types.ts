import type { D1Database, KVNamespace } from "@cloudflare/workers-types"
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

type ShardResolverDeps = {
	coreDb: D1Database
	kv: KVNamespace
}

export type { ShardDbHandle, ShardDriver, ShardMapping, ShardResolverDeps }
