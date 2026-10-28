/**
 * F59 of the 0.13.0 round: a table's generated DTO file depends on its own columns alone. Whether a
 * schema is shared turned on how often it was used across tables, so a column added to one table
 * moved another's field from inline to `_z_…` and rewrote that table's file.
 */
import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { codegen, project, read, useProjects } from "../support/codegen-project.ts"

useProjects()

const tables = (motto: boolean) => `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const author = sqliteTable("author", { id: c.id("aut"), name: c.text("name", { max: 60 })${motto ? ', motto: c.text("motto", { max: 30 })' : ""} })
export const shelf = sqliteTable("shelf", { id: c.id("shf"), label: c.text("label", { max: 30 }) })
`

describe("comb codegen: a column added to one table (F59)", () => {
	it("rewrites no other table's DTO file", async () => {
		const dir = project({ "src/db/db.core.tables.ts": tables(false) })
		await codegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		const before = read(dir, "src/db/dtos/shelf/index.gen.ts")
		fs.writeFileSync(path.join(dir, "src/db/db.core.tables.ts"), tables(true))
		await codegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(read(dir, "src/db/dtos/shelf/index.gen.ts")).toBe(before)
		expect(read(dir, "src/db/dtos/author/index.gen.ts")).toContain("motto")
	}, 240_000)
})
