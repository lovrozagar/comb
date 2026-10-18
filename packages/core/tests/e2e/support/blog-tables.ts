/** The tables every SQLite e2e app is generated from; copied into the app as src/db/core.tables.ts */
import { sqliteTable, uniqueIndex } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"

export const post = sqliteTable(
	"post",
	{
		id: c.id("pst"),
		title: c.text("title", { min: 1, max: 200 }).notNull(),
		status: c.enum("status", ["draft", "published"]).notNull().default("draft"),
		minute_read: c.integer("minute_read", { min: 0 }).notNull().default(0),
		created_at: c.createdAt("created_at"),
		updated_at: c.updatedAt("updated_at"),
		deleted_at: c.deletedAt("deleted_at"),
	},
	(t) => [uniqueIndex("idx_post_title").on(t.title)],
)
