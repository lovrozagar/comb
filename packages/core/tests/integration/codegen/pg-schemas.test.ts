/**
 * F51 of the 0.13.0 round: two tables of one name in two Postgres schemas, Supabase's auth.users
 * beside the app's own users, are two tables to codegen. Each is named `auth.users` where a schema
 * is set, and plainly where none is: in validation, the constraint map and its error keys, the
 * published entity names and the diagram outline. The handler's lookup is src/pg/map-table.ts.
 */
import { describe, expect, it } from "vitest"
import { project, read, runCodegen, useProjects } from "../support/codegen-project.ts"

useProjects()

const TABLES = `import { pgSchema, pgTable, text } from "drizzle-orm/pg-core"
export const auth = pgSchema("auth")
export const authUsers = auth.table("users", { id: text("id").primaryKey(), email: text("email").unique() })
export const users = pgTable("users", { id: text("id").primaryKey(), email: text("email").unique(), authId: text("auth_id").references(() => authUsers.id) })
`

describe("comb codegen: one table name in two Postgres schemas (F51)", () => {
	it("generates both, each under its own name", async () => {
		const dir = project({ "src/db/db.core.tables.ts": TABLES })
		const { code, err } = await runCodegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(code, err).toBe(0)
		/* the constraint map keyed by each, and each one's error keys its own */
		const constraints = read(dir, "src/db/db.core.constraints.gen.ts")
		expect(constraints).toContain('\t"auth.users": {')
		expect(constraints).toContain("\tusers: {")
		expect(constraints).toContain('errorKey: "auth_users_email_duplicate"')
		expect(constraints).toContain('errorKey: "users_email_duplicate"')
		expect(constraints).toContain('referenced: ["id"]')
		/* the published names, unique */
		const manifest = JSON.parse(read(dir, "src/db/db.core.manifest.gen.json")) as { entities: Array<{ name: string }> }
		expect(manifest.entities.map(({ name }) => name)).toEqual(["auth.users", "users"])
		expect(read(dir, "src/db/dtos/auth-users/index.gen.ts")).toContain('name: "auth.users",')
		/* the outline, each part of a qualified name quoted */
		const ddl = read(dir, "src/db/diagrams/core-schema.gen.sql")
		expect(ddl).toContain('CREATE TABLE "auth"."users" (')
		expect(ddl).toContain('CREATE TABLE "users" (')
		expect(ddl).toContain('"auth_id" TEXT REFERENCES "auth"."users"("id")')
		const relations = JSON.parse(read(dir, "src/db/diagrams/core-relations.gen.json")) as {
			relations: Array<{ from: string; to: string }>
		}
		expect(relations.relations).toMatchObject([{ from: "users.auth_id", to: "auth.users.id" }])
		/* raw SQL's table names */
		expect(read(dir, "src/db/table-names/index.gen.ts")).toContain('authUsers: "auth.users",')
	}, 120_000)
})
