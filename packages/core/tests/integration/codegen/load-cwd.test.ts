/**
 * F58 of the 0.13.0 round: codegen loads the tables module from the working directory comb runs
 * in, as the app and drizzle-kit load it, never the tables file's own directory. A module that
 * reads a root-relative path (a limits file, process.cwd()) loads for codegen as it loads for them.
 */
import { describe, expect, it } from "vitest"
import { project, read, runCodegen, useProjects } from "../support/codegen-project.ts"

useProjects()

describe("comb codegen's working directory as it loads the tables module (F58)", () => {
	it("is comb's own, so a root-relative read finds the file the app finds", async () => {
		const dir = project({
			"limits.json": JSON.stringify({ name: 40 }),
			"src/db/db.core.tables.ts": `import fs from "node:fs"
import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
const limits = JSON.parse(fs.readFileSync("limits.json", "utf8")) as { name: number }
export const user = sqliteTable("user", { id: c.id("usr"), name: c.text("name", { max: limits.name }) })
`,
		})
		const { code, err } = await runCodegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(code, err).toBe(0)
		/* the bound, in the core the shared file holds for it (F59) */
		expect(read(dir, "src/db/dtos/_shared/index.gen.ts")).toContain("max(40)")
	}, 120_000)
})
