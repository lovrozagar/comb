/**
 * F55 of the 0.13.0 round: a c.id prefix generateId refuses fails codegen, where it wrote an id
 * generator that threw on every table's first insert, because c.id refuses it as the tables module loads.
 */
import { describe, expect, it } from "vitest"
import { project, runCodegen, useProjects } from "../support/codegen-project.ts"

useProjects()

describe("comb codegen: a c.id prefix generateId refuses (F55)", () => {
	it.each(["Org", "memberships", "tag_v2"])(
		"fails on c.id(%j), naming the file and the rule",
		async (prefix) => {
			const dir = project({
				"src/db/db.core.tables.ts": `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const org = sqliteTable("org", { id: c.id(${JSON.stringify(prefix)}) })
`,
			})
			const { code, err } = await runCodegen(dir, ["--tables", "src/db/db.core.tables.ts"])
			expect(code).not.toBe(0)
			expect(err).toContain("db.core.tables.ts")
			expect(err).toContain(
				`Invalid entity prefix "${prefix}": must be 2-10 lowercase alphanumeric chars starting with a letter`,
			)
		},
		120_000,
	)
})
