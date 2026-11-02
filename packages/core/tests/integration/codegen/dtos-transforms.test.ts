/**
 * C2 of r18: a written text's transforms rewrite the value it stores, so a generated DTO's published
 * schema lists them, in order, as `x-comb-transform`; its bounds and pattern bind the rewritten value.
 */
import path from "node:path"
import * as z from "zod"
import { describe, expect, it } from "vitest"
import { codegen, project, useProjects } from "../support/codegen-project.ts"

useProjects()

const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const member = sqliteTable("member", {
	id: c.id("mbr"),
	title: c.text("title", { trim: true }).notNull(),
	handle: c.text("handle", { lowercase: true, pattern: "/^[a-z]+$/" }),
	email: c.text("email", { email: true }),
	note: c.text("note"),
})
`

describe("a generated DTO's written text transforms", () => {
	it("are published in order on the create and update schemas, and on no read", async () => {
		const dir = project({
			"comb.config.ts": `export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n`,
			"src/db/db.core.tables.ts": TABLES,
		})
		await codegen(dir)
		const dtos = (await import(path.join(dir, "src/db/dtos/member/db.core.member.gen.ts"))) as Record<string, z.ZodType>
		const published = (name: string) => {
			const { properties } = z.toJSONSchema(dtos[name] as z.ZodType, { io: "input" }) as {
				properties: Record<string, Record<string, unknown>>
			}
			return Object.fromEntries(Object.entries(properties).map(([key, field]) => [key, field["x-comb-transform"]]))
		}
		for (const name of ["memberDtoCreateSchema", "memberDtoUpdateSchema"])
			expect(published(name)).toMatchObject({
				email: ["trim", "lowercase"],
				handle: ["lowercase"],
				note: undefined,
				title: ["trim"],
			})
		expect(Object.values(published("memberDtoReadSchema")).filter((listed) => listed !== undefined)).toEqual([])
	}, 120_000)
})
