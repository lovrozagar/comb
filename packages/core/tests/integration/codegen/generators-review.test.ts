/**
 * The 0.9.1 codegen review's generator findings (F2, F7, F8, F10, F11), through the real CLI: the
 * generated relations load, constraint maps and stamps know every unique, and generated SQL runs.
 */
import path from "node:path"
import * as z from "zod"
import { describe, expect, it } from "vitest"
import { readCombEntityMeta } from "../../../src/meta.ts"
import { codegen, project, read, runCodegen, useProjects } from "../support/codegen-project.ts"
import { libsqlMemory } from "../support/libsql.ts"

useProjects()

const HEAD = `import { sqliteTable, unique } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`
const config = (extra = "") =>
	`export default { databases: { core: { tables: "./src/db/db.core.tables.ts"${extra} } } }\n`

describe("tables whose generated paths differ only in case (F2)", () => {
	it("fails, naming both tables, rather than let one's DTOs replace the other's", async () => {
		const dir = project({
			"comb.config.ts": config(),
			"src/db/db.core.tables.ts": `${HEAD}export const apiKey = sqliteTable("api_key", { id: c.id("apk") })
export const apiKEY = sqliteTable("api_key_upper", { id: c.id("apu") })
`,
		})
		const run = await runCodegen(dir)
		expect(run.code).not.toBe(0)
		expect(run.err).toMatch(/apiKey and apiKEY/)
	}, 120_000)
})

describe("a many relation named like a column of its table (F7)", () => {
	it("takes the Relation suffix, so the relations load", async () => {
		const dir = project({
			"comb.config.ts": config(),
			"src/db/db.core.tables.ts": `${HEAD}export const user = sqliteTable("user", { id: c.id("usr"), posts: c.integer("posts") })
export const post = sqliteTable("post", { id: c.id("pst"), userId: c.ref("user_id").references(() => user.id) })
`,
		})
		await codegen(dir)
		expect(read(dir, "src/db/db.core.relations.gen.ts")).toContain("postsRelation: r.many.post(")
		await expect(import(path.join(dir, "src/db/db.core.relations.gen.ts"))).resolves.toBeDefined()
	}, 120_000)
})

describe("drizzle's unique() and a named .unique() (F8)", () => {
	it("map to their own constraint entries and are published as unique indexes", async () => {
		const dir = project({
			"comb.config.ts": config(),
			"src/db/db.core.tables.ts": `${HEAD}export const member = sqliteTable("member", {
	id: c.id("mem"),
	orgId: c.text("org_id").notNull(),
	email: c.text("email").notNull(),
	handle: c.text("handle").notNull().unique("member_handle_uq"),
}, (t) => [unique("member_org_email").on(t.orgId, t.email)])
`,
		})
		await codegen(dir)
		const { CORE_DB_CONSTRAINT_MAP: map } = (await import(path.join(dir, "src/db/db.core.constraints.gen.ts"))) as {
			CORE_DB_CONSTRAINT_MAP: Record<string, { unique?: Record<string, { errorKey: string }> }>
		}
		expect(Object.keys(map["member"]?.unique ?? {}).sort()).toEqual(["handle", "org_id,email"])
		const dtos = (await import(path.join(dir, "src/db/dtos/member/db.core.member.gen.ts"))) as Record<
			string,
			z.ZodObject
		>
		const stamp = readCombEntityMeta(z.toJSONSchema(dtos["memberDtoReadSchema"] as z.ZodObject))
		expect(stamp?.uniqueIndexes).toEqual(
			expect.arrayContaining([
				{ columns: ["handle"], name: "member_handle_uq" },
				{ columns: ["orgId", "email"], name: "member_org_email" },
			]),
		)
	}, 120_000)
})

describe("the diagram DDL and relations JSON (F10)", () => {
	it("quote every identifier and name a key's target by its SQL names, so the DDL runs", async () => {
		const dir = project({
			"comb.config.ts": config(),
			"src/db/db.core.tables.ts": `${HEAD}export const customer = sqliteTable("customers", { id: c.id("cus") })
export const order = sqliteTable("order", { id: c.id("ord"), group: c.text("group").notNull(), buyerId: c.ref("buyer_id").notNull().references(() => customer.id, { onDelete: "cascade" }) })
`,
		})
		await codegen(dir)
		const ddl = read(dir, "src/db/diagrams/core-schema.gen.sql")
		expect(ddl).toContain('REFERENCES "customers"("id")')
		const { client, close } = libsqlMemory()
		try {
			await expect(client.executeMultiple(ddl)).resolves.toBeUndefined()
		} finally {
			close()
		}
		const json = JSON.parse(read(dir, "src/db/diagrams/core-relations.gen.json")) as {
			relations: Array<{ to: string }>
		}
		expect(json.relations.map((relation) => relation.to)).toEqual(["customers.id"])
	}, 120_000)
})

describe("the FTS metadata map (F11)", () => {
	it("lists the FTS table's SQL columns, as its SQL does", async () => {
		const dir = project({
			"comb.config.ts": config(', fts: { post: { columns: ["title", "bodyText", "body_text"] } }'),
			"src/db/db.core.tables.ts": `${HEAD}export const post = sqliteTable("post", { id: c.id("pst"), title: c.text("title"), bodyText: c.text("body_text") })
`,
		})
		await codegen(dir)
		const { CORE_DB_FTS: fts } = (await import(path.join(dir, "src/db/db.core.fts.gen.ts"))) as {
			CORE_DB_FTS: Record<string, { columns: string[] }>
		}
		expect(fts["post"]?.columns).toEqual(["title", "body_text"])
	}, 120_000)
})
