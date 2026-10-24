import { and, eq, isNotNull, isNull, sql } from "drizzle-orm"
import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types"
import { drizzle } from "drizzle-orm/d1"
import { CombError } from "../../../error.ts"
import { combErrorKeys } from "../../../types.ts"
import { openD1Session, type SessionConstraint } from "../session.ts"
import { shardMap } from "./shard-map.ts"
import type { ShardMapping, ShardPick, ShardPickInput } from "./types.ts"

type ShardDb = ReturnType<typeof drizzle>
type ShardRow = typeof shardMap.$inferSelect

/** The default pick: the shard with the most headroom under `maxOrgsPerShard`, the lowest on a tie */
function headroomPick(maxOrgsPerShard: number): ShardPick {
	return ({ counts, totalShards }) => {
		let best: number | undefined
		let bestHeadroom = 0
		for (let shard = 0; shard < totalShards; shard++) {
			const headroom = maxOrgsPerShard - (counts.get(shard) ?? 0)
			if (headroom > bestHeadroom) {
				bestHeadroom = headroom
				best = shard
			}
		}
		return best
	}
}

/** The shard `pick` names for a new org, checked to be one of the router's; shards_full (503) when none */
async function pickShard(
	db: ShardDb,
	pick: ShardPick,
	{ orgId, totalShards }: Omit<ShardPickInput, "counts">,
): Promise<number> {
	const rows = await db
		.select({ count: sql<number>`count(*)`.as("count"), shardId: shardMap.shard_id })
		.from(shardMap)
		.where(and(eq(shardMap.driver, "d1"), isNull(shardMap.deleted_at)))
		.groupBy(shardMap.shard_id)
		.all()
	const shardId = await pick({ counts: new Map(rows.map((row) => [row.shardId, row.count])), orgId, totalShards })
	if (shardId === undefined) {
		/* an operator capacity problem, not the client's: provision another D1 database */
		throw new CombError({
			cause: "No shard has capacity for a new organization.",
			errorKey: combErrorKeys.SHARDS_FULL,
			status: "service_unavailable",
		})
	}
	assertShard(shardId, totalShards)
	return shardId
}

function assertShard(shardId: number, totalShards: number): void {
	if (!Number.isInteger(shardId) || shardId < 0 || shardId >= totalShards)
		throw new RangeError(`Shard ${shardId} is not one of the ${totalShards} shards`)
}

/**
 * Places an org on `shardId` unless it has a row already: the first writer wins, and an org
 * soft-deleted since is revived where it was, where its data is. Returns the row that stands.
 */
async function insertFirst(db: ShardDb, orgId: string, shardId: number): Promise<{ revived: boolean; row: ShardRow }> {
	const byOrg = eq(shardMap.org_id, orgId)
	await db
		.insert(shardMap)
		.values({ driver: "d1", org_id: orgId, shard_id: shardId, target: String(shardId) })
		.onConflictDoNothing({ target: shardMap.org_id })
	const revived = await db
		.update(shardMap)
		.set({ deleted_at: null, updated_at: Date.now() })
		.where(and(byOrg, isNotNull(shardMap.deleted_at)))
		.returning({ orgId: shardMap.org_id })
	return { revived: revived.length > 0, row: (await db.select().from(shardMap).where(byOrg).get()) as ShardRow }
}

/** Puts an org on `shardId` whatever row it had, live or soft-deleted */
async function overwrite(db: ShardDb, orgId: string, shardId: number): Promise<ShardRow> {
	const placed = { deleted_at: null, shard_id: shardId, target: String(shardId), updated_at: Date.now() }
	const [row] = await db
		.insert(shardMap)
		.values({ driver: "d1", org_id: orgId, ...placed })
		.onConflictDoUpdate({ set: placed, target: shardMap.org_id })
		.returning()
	return row as ShardRow
}

/** Soft-deletes an org's live row, leaving its shard on record for a revival */
async function softDelete(db: ShardDb, orgId: string): Promise<void> {
	await db
		.update(shardMap)
		.set({ deleted_at: Date.now(), updated_at: Date.now() })
		.where(and(eq(shardMap.org_id, orgId), isNull(shardMap.deleted_at)))
}

/**
 * The live mapping a session under `constraint` reads, with its bookmark, and the session; no
 * mapping when the org has no live row there
 */
async function readLiveRow(
	coreDb: D1Database,
	orgId: string,
	constraint: SessionConstraint,
): Promise<{ mapping: ShardMapping | undefined; session: D1DatabaseSession | undefined }> {
	const { client, session } = openD1Session(coreDb, { constraint })
	const row = await drizzle(client)
		.select()
		.from(shardMap)
		.where(and(eq(shardMap.org_id, orgId), isNull(shardMap.deleted_at)))
		.get()
	return { mapping: row ? toMapping(row, session?.getBookmark()) : undefined, session }
}

/** The live mapping in the core database: the nearest replica's, else the primary's */
async function readLive(coreDb: D1Database, orgId: string): Promise<ShardMapping | undefined> {
	const nearest = await readLiveRow(coreDb, orgId, "first-unconstrained")
	/* with no session there is one database, so its miss is the primary's */
	if (nearest.mapping || !nearest.session) return nearest.mapping
	return (await readLiveRow(coreDb, orgId, "first-primary")).mapping
}

function toMapping(row: ShardRow, bookmark: string | null | undefined): ShardMapping {
	return {
		createdAt: row.created_at,
		d1Bookmark: bookmark ?? undefined,
		deletedAt: row.deleted_at,
		driver: row.driver,
		orgId: row.org_id,
		shardId: row.shard_id,
		target: row.target,
		updatedAt: row.updated_at,
	}
}

export { assertShard, headroomPick, insertFirst, overwrite, pickShard, readLive, readLiveRow, softDelete, toMapping }
export type { ShardDb, ShardRow }
