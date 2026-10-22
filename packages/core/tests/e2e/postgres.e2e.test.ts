/**
 * The Postgres path end to end with the comb binary: init --dialect postgres, diff through
 * drizzle-kit's export and the real Atlas, apply and status, rows written through comb's pg
 * column builders, then a column, a view and a policy added, a column dropped (refused until the
 * file approves it), and a re-diff that finds the history synced. Two scratch databases on
 * COMB_TEST_PG_URL, the target and Atlas's dev database, are made and dropped here; unset locally,
 * the suite skips and says why, and CI requires it.
 */
import { randomUUID } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { drizzle } from "drizzle-orm/node-postgres"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { hashDir } from "../../src/migrate/core/atlas-dir.ts"
import { run } from "../../src/migrate/core/process.ts"
import { pgUrl } from "../integration/support/pg.ts"
import { app, ok, type App } from "./support/project.ts"

const server = pgUrl()

/** The tables file: comb's pg column builders, with whatever else a step adds */
const tables = (more = "", columns = "") => `import { sql } from "drizzle-orm"
import { pgPolicy, pgTable, pgView, text } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"

export const post = pgTable("post", {
	id: c.id("pst"),
	title: c.text("title").notNull(),
	createdAt: c.createdAt("created_at"),${columns}
})${more}
`

const VIEW_AND_POLICY = `.enableRLS()

export const titles = pgView("titles").as((qb) => qb.select({ title: post.title }).from(post))
export const readable = pgPolicy("readable", { as: "permissive", for: "select", to: "public", using: sql\`true\` }).link(post)`

async function admin<T>(sql: string): Promise<T[]> {
	const client = new pg.Client({ connectionString: server })
	await client.connect()
	try {
		return (await client.query(sql)).rows as T[]
	} finally {
		await client.end()
	}
}

const database = (name: string) => {
	const url = new URL(server as string)
	url.pathname = `/${name}`
	return url.href
}

describe.skipIf(server === undefined)(
	server === undefined ? "comb on Postgres (COMB_TEST_PG_URL unset)" : "comb on Postgres",
	() => {
		const id = randomUUID().replaceAll("-", "")
		const [target, dev] = [`comb_e2e_${id}`, `comb_e2e_${id}_dev`]
		let project: App
		let migrations = ""

		beforeAll(async () => {
			for (const name of [target, dev]) await admin(`CREATE DATABASE ${name}`)
			project = app({ "src/db/core.tables.ts": tables() }, { DATABASE_URL: database(target), DEV_URL: database(dev) })
			ok(project.comb("migrate", "init", "--dialect", "postgres"), "migrate init")
			const config = join(project.dir, "comb.migrate.config.ts")
			writeFileSync(
				config,
				readFileSync(config, "utf8").replace(
					'type: "postgres",',
					'devUrl: process.env["DEV_URL"] ?? "",\n\t\t\t\ttype: "postgres",',
				),
			)
			migrations = join(project.dir, "atlas-migrations")
		}, 180_000)

		afterAll(async () => {
			for (const name of [target, dev]) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
		})

		it("diffs the first migration, applies it, and reports it applied", () => {
			expect(ok(project.comb("migrate", "diff", "core", "init"), "diff").stdout).toContain("Generated:")
			expect(ok(project.comb("migrate", "apply", "core"), "apply").stdout).toContain("Done: 1 applied")
			expect(ok(project.comb("migrate", "status", "core"), "status").stdout).toContain("Pending: none")
		}, 180_000)

		it("writes rows through the pg column builders, created_at an epoch-millisecond number", async () => {
			const { post } = (await import(join(project.dir, "src/db/core.tables.ts"))) as { post: never }
			const client = new pg.Client({ connectionString: database(target) })
			await client.connect()
			try {
				const db = drizzle({ client })
				await db.insert(post).values({ id: "pst_1", title: "Hello" } as never)
				const [row] = (await db.select().from(post)) as Array<{ createdAt: number; title: string }>
				expect(row?.title).toBe("Hello")
				expect(typeof row?.createdAt).toBe("number")
			} finally {
				await client.end()
			}
		}, 60_000)

		it("adds a column, a view and a policy, and applies them", async () => {
			project.write({ "src/db/core.tables.ts": tables(VIEW_AND_POLICY, '\n\tbody: text("body"),') })
			ok(project.comb("migrate", "diff", "core", "view"), "diff")
			/* a policy changes which rows a role sees and destroys none: cautious, so --yes applies it (M16) */
			ok(project.comb("migrate", "apply", "core", "--yes"), "apply")
			const client = new pg.Client({ connectionString: database(target) })
			await client.connect()
			try {
				expect((await client.query("SELECT viewname FROM pg_views WHERE schemaname = 'public'")).rows).toEqual([
					{ viewname: "titles" },
				])
				expect((await client.query("SELECT polname FROM pg_policy")).rows).toEqual([{ polname: "readable" }])
			} finally {
				await client.end()
			}
		}, 180_000)

		it("refuses to drop a column until the migration approves it, then drops it", () => {
			project.write({ "src/db/core.tables.ts": tables(VIEW_AND_POLICY) })
			ok(project.comb("migrate", "diff", "core", "drop_body"), "diff")
			const refused = project.comb("migrate", "apply", "core", "--yes")
			expect(refused.status).toBe(1)
			expect(refused.stderr).toContain("is unsafe")
			const file = readdirSync(migrations).filter((name) => name.endsWith("_drop_body.sql"))[0] as string
			const path = join(migrations, file)
			writeFileSync(path, `-- comb:allow-unsafe: body moved to a separate table\n${readFileSync(path, "utf8")}`)
			hashDir(run, migrations)
			expect(ok(project.comb("migrate", "apply", "core"), "apply").stdout).toContain("Approved in")
		}, 180_000)

		it("finds the history and the schema in sync", () => {
			expect(ok(project.comb("migrate", "diff", "core", "again"), "diff").stdout).toContain("already in sync")
		}, 180_000)
	},
)
