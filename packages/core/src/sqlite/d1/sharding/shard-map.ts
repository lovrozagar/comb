import { type BuildColumns, type HasDefault, type IsPrimaryKey, type NotNull, sql } from "drizzle-orm"
import { sqliteTable as createTable, index, type SQLiteTableWithColumns } from "drizzle-orm/sqlite-core"
import { c, type SqliteColumns } from "../../columns.ts"
import type { ShardDriver } from "./types.ts"

const SHARD_DRIVERS: readonly ["d1"] = ["d1"] as const satisfies readonly ShardDriver[]

/** The longest org id `shard_map.org_id` holds; a longer one is no org's */
export const ORG_ID_MAX_LENGTH = 64

/**
 * Refuse an org id longer than the column holds, measured in UTF-16 code units as `resolve`
 * measures it, so no row is written that `resolve` would answer as a miss (U41). The id is the
 * caller's input: a route that takes it from a path validates it first.
 */
export function assertOrgId(orgId: string): void {
	if (orgId.length > ORG_ID_MAX_LENGTH)
		throw new RangeError(
			`orgId must be at most ${ORG_ID_MAX_LENGTH} UTF-16 code units, the length shard_map.org_id holds, got ${orgId.length}`,
		)
}

/** Each column's builder, from the `c` factory that makes it */
type ShardMapColumns = {
	created_at: ReturnType<SqliteColumns["createdAt"]>
	deleted_at: ReturnType<SqliteColumns["deletedAt"]>
	driver: HasDefault<NotNull<ReturnType<typeof c.enum<readonly ["d1"]>>>>
	org_id: IsPrimaryKey<ReturnType<SqliteColumns["text"]>>
	shard_id: NotNull<ReturnType<SqliteColumns["integer"]>>
	target: NotNull<ReturnType<SqliteColumns["text"]>>
	updated_at: ReturnType<SqliteColumns["updatedAt"]>
}

type ShardMapTable = SQLiteTableWithColumns<{
	name: "shard_map"
	schema: undefined
	columns: BuildColumns<"shard_map", ShardMapColumns, "sqlite">
	dialect: "sqlite"
}>

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

export const shardMap: ShardMapTable = /* @__PURE__ */ defineShardMap()
