import { type HasDefault, type IsPrimaryKey, type NotNull, sql } from "drizzle-orm"
import { sqliteTable as createTable, index } from "drizzle-orm/sqlite-core"
import { c, type SqliteColumns } from "../../columns.ts"
import type { ShardDriver } from "./types.ts"

const SHARD_DRIVERS: readonly ["d1"] = ["d1"] as const satisfies readonly ShardDriver[]

/** The longest org id `shard_map.org_id` holds; a longer one is no org's */
export const ORG_ID_MAX_LENGTH = 64

/**
 * Refuse an org id longer than the column holds, measured in UTF-16 code units as `resolve`
 * measures it, so no row is written that `resolve` would answer as a miss. The id is the
 * caller's input: a route that takes it from a path validates it first.
 */
export function assertOrgId(orgId: string): void {
	if (orgId.length > ORG_ID_MAX_LENGTH)
		throw new RangeError(
			`orgId must be at most ${ORG_ID_MAX_LENGTH} UTF-16 code units, the length shard_map.org_id holds, got ${orgId.length}`,
		)
}

/** Each column's builder, from the `c` factory that makes it */
export type ShardMapColumns = {
	/** when the org was first placed, in epoch milliseconds, filled on insert */
	created_at: ReturnType<SqliteColumns["createdAt"]>
	/** when the org was unplaced, in epoch milliseconds; null while its row is live */
	deleted_at: ReturnType<SqliteColumns["deletedAt"]>
	/** the kind of database the shard is, `"d1"` by default */
	driver: HasDefault<NotNull<ReturnType<typeof c.enum<readonly ["d1"]>>>>
	/** the org's id, the primary key, at most 64 UTF-16 code units */
	org_id: IsPrimaryKey<ReturnType<SqliteColumns["text"]>>
	/** the shard the org's rows are on */
	shard_id: NotNull<ReturnType<SqliteColumns["integer"]>>
	/** the suffix of the `SHARD_DB_<target>` binding the router opens, at most 128 characters; comb writes String(shard_id), so a hand-written move of shard_id writes it too */
	target: NotNull<ReturnType<SqliteColumns["text"]>>
	/** when the row last changed, in epoch milliseconds */
	updated_at: ReturnType<SqliteColumns["updatedAt"]>
}

// drizzle's own table type, so it follows each drizzle the peer range admits (rc.5 added `isAlias`)
/** The drizzle table type of `shard_map`, for a query or a migration schema that names it */
export type ShardMapTable = ReturnType<typeof createTable<"shard_map", ShardMapColumns>>

/* the table is built in a function so module scope runs one call, marked pure */
function defineShardMap(): ShardMapTable {
	return createTable(
		"shard_map",
		{
			created_at: c.createdAt("created_at"),
			deleted_at: c.deletedAt("deleted_at"),
			driver: c.enum("driver", SHARD_DRIVERS).notNull().default("d1"),
			org_id: c.text("org_id", { max: ORG_ID_MAX_LENGTH }).primaryKey(),
			shard_id: c.integer("shard_id").notNull(),
			/* the binding the router opens, with `driver` (router.ts): comb writes String(shard_id), so a raw
			   move of shard_id writes it too, or goes through router.move({ with }), which writes both */
			target: c.text("target", { max: 128 }).notNull(),
			updated_at: c.updatedAt("updated_at"),
		},
		(t) => [
			index("idx_shard_map_shard_id").on(t.shard_id),
			index("idx_shard_map_driver")
				.on(t.driver)
				.where(sql`deleted_at IS NULL`),
		],
	)
}

/**
 * The core database's `shard_map` table, one row per org placed: which shard its rows are on.
 * Include it in the core database's schema so its migrations create it, with an index on
 * `shard_id` and one on `driver` over live rows. The router writes it; read it for an operator's
 * view, and change a row through `router.move` so its caches are invalidated.
 */
export const shardMap: ShardMapTable = /* @__PURE__ */ defineShardMap()
