/**
 * C20 of the 0.14.1 review: one spelling for every generated subpath. A table's DTOs, rqb-cols and
 * sql-cols are each exported, and written, under the table's name in kebab case, whether the
 * table's variable is camelCase or snake_case; before 0.15 the DTOs were kebab and the cols kept
 * the variable's own spelling.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { codegen, exportsOf, project, typecheck, useProjects } from "../support/codegen-project.ts"

useProjects()

const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const blogPost = sqliteTable("blog_post", { id: c.id("pst"), title: c.text("title") })
export const table_template = sqliteTable("table_template", { id: c.id("tpl"), name: c.text("name") })
`

describe("comb codegen: generated subpaths", () => {
	it("exports and writes each table's DTOs, rqb-cols and sql-cols under one kebab-case name", async () => {
		const dir = project({
			"comb.config.ts": 'export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n',
			"src/db/db.core.tables.ts": TABLES,
		})
		await codegen(dir)
		const keys = Object.keys(exportsOf(dir)).filter((key) => /\/(?:dtos|rqb-cols|sql-cols)\//.test(key))
		expect(keys.toSorted()).toEqual(
			[
				"./dtos/_shared",
				"./dtos/blog-post",
				"./dtos/table-template",
				"./rqb-cols/blog-post",
				"./rqb-cols/table-template",
				"./sql-cols/blog-post",
				"./sql-cols/table-template",
			].toSorted(),
		)
		const generated = Object.values(exportsOf(dir)).filter((target) => target.endsWith(".gen.ts"))
		expect(generated.filter((target) => !fs.existsSync(path.join(dir, target)))).toEqual([])
		typecheck(dir)
	}, 120_000)
})
