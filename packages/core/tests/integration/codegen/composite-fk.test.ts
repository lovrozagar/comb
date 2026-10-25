/**
 * F46 of the 0.13.0 round, through the real CLI: a composite foreign key's relation joins on every
 * column pair, so `with:` serves the row the key references; the constraint map knows each of its
 * columns, and the update DTO takes neither.
 */
import path from "node:path"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"
import type * as z from "zod"
import { codegen, project, read, useProjects } from "../support/codegen-project.ts"
import { libsqlMemory } from "../support/libsql.ts"

useProjects()

const TABLES = `import { foreignKey, primaryKey, sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const member = sqliteTable("member", { orgId: c.text("org_id").notNull(), userId: c.text("user_id").notNull(), role: c.text("role") }, (t) => [primaryKey({ columns: [t.orgId, t.userId] })])
export const grant = sqliteTable("grant", { id: c.id("grt"), orgId: c.text("org_id").notNull(), userId: c.text("user_id").notNull(), note: c.text("note") }, (t) => [foreignKey({ columns: [t.orgId, t.userId], foreignColumns: [member.orgId, member.userId] })])
`

describe("a composite foreign key (F46)", () => {
	it("serves the row both columns reference through with:, maps each column's key, and updates neither", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n`,
			"src/db/db.core.tables.ts": TABLES,
		})
		await codegen(dir)
		const { relations } = (await import(path.join(dir, "src/db/db.core.relations.gen.ts"))) as { relations: never }
		const { client, close } = libsqlMemory()
		try {
			await client.executeMultiple(read(dir, "src/db/diagrams/core-schema.gen.sql"))
			await client.executeMultiple(`PRAGMA foreign_keys = ON;
INSERT INTO "member" VALUES ('o1', 'u1', 'owner'), ('o1', 'u2', 'guest'), ('o2', 'u1', 'admin');
INSERT INTO "grant" VALUES ('grt_1', 'o1', 'u2', NULL);`)
			const db = drizzle({ client, relations })
			const query = db.query as unknown as Record<string, { findFirst(options: object): Promise<unknown> }>
			const found = await query["grant"]?.findFirst({ with: { member: true } })
			expect(found).toMatchObject({ member: { orgId: "o1", role: "guest", userId: "u2" } })
			const back = await query["member"]?.findFirst({ where: { orgId: "o1", userId: "u2" }, with: { grants: true } })
			expect(back).toMatchObject({ grants: [{ id: "grt_1" }] })
		} finally {
			close()
		}
		const { CORE_DB_CONSTRAINT_MAP: map } = (await import(path.join(dir, "src/db/db.core.constraints.gen.ts"))) as {
			CORE_DB_CONSTRAINT_MAP: Record<string, { foreignKey?: Record<string, unknown> }>
		}
		expect(Object.keys(map["grant"]?.foreignKey ?? {}).sort()).toEqual(["org_id", "user_id"])
		/* a body repoints neither column: each is a reference, out of the update DTO */
		const dtos = (await import(path.join(dir, "src/db/dtos/grant/db.core.grant.gen.ts"))) as Record<string, z.ZodObject>
		expect(Object.keys((dtos["grantDtoUpdateSchema"] as z.ZodObject).shape)).toEqual(["note"])
	}, 120_000)
})
