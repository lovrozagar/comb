/**
 * C1 of r18: every generated DTO module, `_shared` among them, loads. zod builds a schema's regexes
 * when its module is imported, so a range zod cannot build fails here and never on an app's import.
 * Each dialect's columns sit at the edge of the range comb holds them to.
 */
import path from "node:path"
import { describe, expect, it } from "vitest"
import { codegen, generatedFiles, project, useProjects } from "../support/codegen-project.ts"

useProjects()

const CONFIG = `export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n`

/* every text kind at its tightest range, beside a column of every other kind */
const COLUMNS = `id: c.id("itm"),
	pw: c.text("pw", { password: true, min: 72 }).notNull(),
	pw_short: c.text("pw_short", { password: true, max: 8 }),
	url: c.text("url", { url: true, max: 9 }),
	one: c.text("one", { max: 1 }).notNull(),
	email: c.text("email", { email: true, max: 254 }),
	name: c.text("name", { name: true, trim: true, lowercase: true, max: 80 }),
	image: c.text("image", { imageUri: true }),
	slug: c.text("slug", { pattern: "/^[a-z]+$/", min: 2, max: 2 }),
	owner: c.ref("owner"),
	state: c.enum("state", ["draft", "live"]).notNull(),
	count: c.integer("count", { min: 0, max: 0 }),
	ratio: c.real("ratio"),
	flag: c.boolean("flag"),
	doc: c.json("doc", docSchema),
	at: c.timestamp("at"),
	created_at: c.createdAt("created_at"),
	updated_at: c.updatedAt("updated_at"),`

const TABLES = {
	postgres: `import * as z from "zod"
import { pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
export const docSchema = z.object({ a: z.string() })
export const item = pgTable("item", {
	${COLUMNS}
})
`,
	sqlite: `import * as z from "zod"
import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const docSchema = z.object({ a: z.string() })
export const item = sqliteTable("item", {
	${COLUMNS}
})
`,
}

describe("every generated DTO module loads", () => {
	it.each(Object.entries(TABLES))(
		"on %s, _shared among them",
		async (_, tables) => {
			const dir = project({ "comb.config.ts": CONFIG, "src/db/db.core.tables.ts": tables })
			await codegen(dir)
			const modules = generatedFiles(dir).filter((file) => file.includes("dtos") && file.endsWith(".gen.ts"))
			expect(modules.some((file) => file.includes("_shared"))).toBe(true)
			for (const file of modules) await expect(import(path.join(dir, file)), file).resolves.toBeDefined()
		},
		120_000,
	)
})
