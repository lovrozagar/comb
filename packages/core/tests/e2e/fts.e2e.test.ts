/**
 * An FTS project end to end: comb.config.ts declares an FTS5 index, `migrate diff` writes the
 * virtual table and its triggers beside Atlas's diff, `migrate apply` puts both on a libsql file,
 * and the generated index answers a prefix search for rows inserted after it.
 */
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { beforeAll, describe, expect, it } from "vitest"
import { buildFtsWhere } from "../../src/query/sqlite/search.ts"
import { app, BLOG, ok, type App } from "./support/project.ts"

const CONFIG = `import { defineCodegenConfig } from "@lovrozagar/comb/codegen"

export default defineCodegenConfig({
	databases: {
		core: {
			dialect: "sqlite",
			driver: "d1",
			fts: { post: { columns: ["title"] } },
			output: { default: "./src/db/_gen" },
			tables: "./src/db/core.tables.ts",
		},
	},
})
`

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

let search: App

beforeAll(() => {
	search = app({ ...BLOG, "comb.config.ts": CONFIG, "comb.migrate.config.ts": MIGRATE_CONFIG })
	ok(search.comb("codegen", "core"), "codegen")
	ok(search.comb("migrate", "init"), "migrate init")
	ok(search.comb("migrate", "diff", "core", "init"), "migrate diff")
	ok(search.comb("migrate", "apply", "core", "-e", "local"), "migrate apply")
}, 180_000)

describe("comb with FTS5, from config to a search", () => {
	it("indexes rows through the migrated triggers and finds them by prefix", async () => {
		const client = createClient({ url: `file:${join(search.dir, "local.db")}` })
		const db = drizzle({ client })
		try {
			await client.execute("INSERT INTO post (id, title) VALUES ('pst_1', 'Postgres tuning'), ('pst_2', 'Gardening')")
			const where = buildFtsWhere("post_fts", "rowid", "postg")
			const rows = await db.all<{ id: string }>(sql`SELECT id FROM post WHERE ${where}`)
			expect(rows).toEqual([{ id: "pst_1" }])
		} finally {
			client.close()
		}
	}, 120_000)
})
