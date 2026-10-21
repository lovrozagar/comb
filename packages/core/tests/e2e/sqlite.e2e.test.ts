/**
 * The README's path on SQLite, end to end: codegen, `migrate init`, `migrate diff` through real
 * Atlas, `migrate apply` onto a libsql file, then a list query served through the generated DTOs
 * and constraint map against the migrated database.
 */
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { beforeAll, describe, expect, it } from "vitest"
import type * as z from "zod"
import { queryHelpers } from "../../src/query/drizzle.ts"
import { createListQuerySchema } from "../../src/query/schema.ts"
import { applyListQuery, buildListQuery } from "../../src/query/sqlite/build-list-query.ts"
import { sqliteErrorHandler } from "../../src/sqlite/constraint-handler.ts"
import type { ConstraintMap } from "../../src/types.ts"
import { app, BLOG, ok, type App } from "./support/project.ts"
import { SIGNED } from "../../src/query/__fixtures__/cursor-secret.ts"

const MIGRATE_CONFIG = `import { defineConfig } from "@lovrozagar/comb/migrate"

export default defineConfig({
	databases: {
		core: {
			environments: { local: { name: "local", provider: { type: "libsql", url: "file:./local.db" } } },
			migrationsDir: "./atlas-migrations",
		},
	},
})
`

let blog: App

beforeAll(() => {
	blog = app({ ...BLOG, "comb.migrate.config.ts": MIGRATE_CONFIG })
	ok(blog.comb("codegen", "core"), "codegen")
	ok(blog.comb("migrate", "init"), "migrate init")
	ok(blog.comb("migrate", "diff", "core", "init"), "migrate diff")
}, 180_000)

describe("comb on SQLite, from tables to a served list", () => {
	it("applies the diffed migration once, and skips it the next time", () => {
		expect(ok(blog.comb("migrate", "apply", "core", "-e", "local"), "apply").stdout).toContain("1 applied")
		expect(ok(blog.comb("migrate", "apply", "core", "-e", "local"), "apply again").stdout).toContain(
			"Skip (already applied)",
		)
	}, 120_000)

	it("serves a filtered, sorted page through the generated DTOs and maps a duplicate to its key", async () => {
		type Dtos = { postDtoCreateSchema: z.ZodType; postDtoReadSchema: z.ZodType }
		const dtos = (await import(join(blog.dir, "src/db/_gen/dtos/post/db.core.post.gen.ts"))) as Dtos
		const { post } = (await import(
			join(blog.dir, "src/db/core.tables.ts")
		)) as typeof import("./support/blog-tables.ts")
		const constraints = (await import(join(blog.dir, "src/db/_gen/db.core.constraints.gen.ts"))) as {
			CORE_DB_CONSTRAINT_MAP: ConstraintMap
		}
		const client = createClient({ url: `file:${join(blog.dir, "local.db")}` })
		const db = drizzle({ client })
		try {
			for (const [i, row] of [
				{ minute_read: 3, status: "published", title: "Beta" },
				{ minute_read: 9, status: "draft", title: "Alpha" },
				{ minute_read: 5, status: "published", title: "Alpha 2" },
			].entries()) {
				const create = dtos.postDtoCreateSchema.parse(row) as typeof post.$inferInsert
				await db.insert(post).values({ ...create, id: `pst_${i}` })
			}
			/* the create DTO refuses what the column constraints refuse */
			expect(dtos.postDtoCreateSchema.safeParse({ title: "" }).success).toBe(false)

			const schema = createListQuerySchema({ filter: { minute_read: "number", status: "enum" }, sort: ["title"] })
			const parsed = schema.parse({ filter: "status.eq.published", limit: "1", order: "title.asc" })
			const rows = await applyListQuery(
				db.select().from(post).$dynamic(),
				buildListQuery({ ...SIGNED, parsed, table: post }),
			)
			const [items, pagination] = queryHelpers.paginate(rows, parsed, SIGNED)
			expect(items.map((row) => row.title)).toEqual(["Alpha 2"])
			expect(pagination).toMatchObject({ hasMore: true, limit: 1 })
			for (const row of rows) expect(dtos.postDtoReadSchema.safeParse(row).success).toBe(true)

			const duplicate = await db
				.insert(post)
				.values({ id: "pst_9", title: "Beta" })
				.then(
					() => null,
					(error: unknown) => error,
				)
			expect(() => sqliteErrorHandler(duplicate, [constraints.CORE_DB_CONSTRAINT_MAP])).toThrow(
				expect.objectContaining({ errorKey: "post_title_duplicate", status: 409 }),
			)
		} finally {
			client.close()
		}
	}, 120_000)
})
