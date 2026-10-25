/**
 * F47 of the 0.13.0 round, through the real CLI: once a table spreads the enum CHECKs codegen
 * generates, the reader sees comb's own CHECK as declared. Codegen maps it once, as comb's, and
 * runs again; a hand CHECK under comb's name that checks something else fails, saying so.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { codegen, project, runCodegen, useProjects } from "../support/codegen-project.ts"

useProjects()

const CONFIG = `export default { databases: { core: { tables: "./src/db/db.core.tables.ts" } } }\n`
const tables = (head: string, third: string) => `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
${head}
export const item = sqliteTable("item", { id: c.id("itm"), status: c.enum("status", ["open", "it's done"]) }${third})
`
const TABLES = "src/db/db.core.tables.ts"

type Checks = Record<string, { check?: Record<string, { errorKey: string }> }>

describe("the enum CHECKs codegen generates, once applied (F47)", () => {
	it("maps comb's CHECK once, as its own, and codegen runs again", async () => {
		const dir = project({ "comb.config.ts": CONFIG, [TABLES]: tables("", "") })
		await codegen(dir)
		fs.writeFileSync(
			path.join(dir, TABLES),
			tables(`import { itemEnumChecks } from "./db.core.enum-checks.gen.ts"`, ", (t) => [...itemEnumChecks(t)]"),
		)
		await codegen(dir)
		const { CORE_DB_CONSTRAINT_MAP: map } = (await import(path.join(dir, "src/db/db.core.constraints.gen.ts"))) as {
			CORE_DB_CONSTRAINT_MAP: Checks
		}
		expect(map["item"]?.check).toEqual({
			item_status_enum: expect.objectContaining({ errorKey: "item_status_enum_invalid" }),
		})
	}, 120_000)

	it("refuses a hand CHECK under comb's name that checks something else", async () => {
		const head = `import { sql } from "drizzle-orm"\nimport { check } from "drizzle-orm/sqlite-core"`
		const dir = project({
			"comb.config.ts": CONFIG,
			[TABLES]: tables(head, `, (t) => [check("item_status_enum", sql\`\${t.status} <> 'open'\`)]`),
		})
		const run = await runCodegen(dir)
		expect(run.code).not.toBe(0)
		expect(run.err).toContain(
			"item: the CHECK item_status_enum takes the name comb gives the enum CHECK of item.status, but checks something else; rename it",
		)
		expect(run.err).not.toContain("63 bytes")
	}, 120_000)
})
