/**
 * The row types a table built from `c` gives a consumer, on SQLite and PostgreSQL. Checked by
 * `bun run typecheck`; nothing here runs.
 */
import { pgTable } from "drizzle-orm/pg-core"
import { sqliteTable } from "drizzle-orm/sqlite-core"
import { expectTypeOf } from "vitest"
import * as z from "zod"
import { c as pg } from "../../src/pg/columns.ts"
import { c } from "../../src/sqlite/columns.ts"

const settings = z.object({ theme: z.enum(["light", "dark"]) })

const post = sqliteTable("post", {
	active: c.boolean("active"),
	created_at: c.createdAt("created_at"),
	deleted_at: c.deletedAt("deleted_at"),
	id: c.id("pst"),
	settings: c.json("settings", settings),
	status: c.enum("status", ["draft", "sent"] as const),
	title: c.text("title", { max: 200 }).notNull(),
	views: c.integer("views"),
})
type Post = typeof post.$inferSelect
type NewPost = typeof post.$inferInsert

expectTypeOf<Post["id"]>().toEqualTypeOf<string>()
expectTypeOf<Post["status"]>().toEqualTypeOf<"draft" | "sent" | null>()
expectTypeOf<Post["settings"]>().toEqualTypeOf<{ theme: "light" | "dark" } | null>()
expectTypeOf<Post["created_at"]>().toEqualTypeOf<number>()
expectTypeOf<Post["deleted_at"]>().toEqualTypeOf<number | null>()
expectTypeOf<Post["active"]>().toEqualTypeOf<boolean | null>()
expectTypeOf<Post["title"]>().toEqualTypeOf<string>()
/* a column with a DB default, and the primary key, may be left out of an insert */
expectTypeOf<NewPost>().toHaveProperty("created_at").toEqualTypeOf<number | undefined>()

const row = pgTable("row", {
	created_at: pg.createdAt("created_at"),
	id: pg.serialId(),
	payload: pg.json<{ n: number }>("payload"),
	status: pg.enum("status", ["a", "b"] as const),
})
type Row = typeof row.$inferSelect

expectTypeOf<Row["id"]>().toEqualTypeOf<number>()
expectTypeOf<Row["created_at"]>().toEqualTypeOf<number>()
expectTypeOf<Row["payload"]>().toEqualTypeOf<{ n: number } | null>()
expectTypeOf<Row["status"]>().toEqualTypeOf<"a" | "b" | null>()
