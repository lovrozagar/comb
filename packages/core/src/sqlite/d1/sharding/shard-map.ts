import { sql } from "drizzle-orm"
import { sqliteTable as createTable, index } from "drizzle-orm/sqlite-core"
import { c } from "../../columns.ts"
import type { ShardDriver } from "./types.ts"

const SHARD_DRIVERS = ["d1"] as const satisfies readonly ShardDriver[]

export const shardMap = createTable(
	"shard_map",
	{
		created_at: c.createdAt("created_at"),
		deleted_at: c.deletedAt("deleted_at"),
		driver: c.enum("driver", SHARD_DRIVERS).notNull().default("d1"),
		org_id: c.text("org_id", { max: 64 }).primaryKey(),
		shard_id: c.integer("shard_id").notNull(),
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
