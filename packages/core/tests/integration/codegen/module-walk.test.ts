/**
 * F52 of the 0.13.0 round: codegen walks the modules the tables file loads as the runtime loads
 * them. A JSON import holds no table and is not transpiled as TypeScript, and a project `.js` with
 * its own `.d.ts`, as checked-in generated code ships, is loaded from the `.js` the runtime runs.
 */
import { describe, expect, it } from "vitest"
import { project, read, runCodegen, useProjects } from "../support/codegen-project.ts"

useProjects()

const HEAD = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`

describe("the modules codegen walks, as the runtime loads them (F52)", () => {
	it("takes a tables module that imports JSON", async () => {
		const dir = project({
			"src/db/roles.json": JSON.stringify(["admin", "member"]),
			"src/db/db.core.tables.ts": `${HEAD}import roles from "./roles.json" with { type: "json" }
export const user = sqliteTable("user", { id: c.id("usr"), role: c.text("role", { max: roles.length * 10 }) })
`,
		})
		const { code, err } = await runCodegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(code, err).toBe(0)
		/* the bound, in the core the shared file holds for it (F59) */
		expect(read(dir, "src/db/dtos/_shared/index.gen.ts")).toContain("max(20)")
	}, 120_000)

	it("finds a schema in a .js module that has its own .d.ts", async () => {
		const dir = project({
			"src/db/address.js": 'import * as z from "zod"\nexport const address = z.object({ street: z.string() })\n',
			"src/db/address.d.ts":
				'import type * as z from "zod"\nexport declare const address: z.ZodObject<{ street: z.ZodString }>\n',
			"src/db/db.core.tables.ts": `${HEAD}import { address } from "./address.js"
export const user = sqliteTable("user", { id: c.id("usr"), address: c.json("address", address) })
`,
		})
		const { code, err } = await runCodegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		expect(code, err).toBe(0)
		expect(read(dir, "src/db/dtos/user/index.gen.ts")).toMatch(
			/import \{ address \} from "\.\.\/\.\.\/address(?:\.js)?"/,
		)
	}, 120_000)
})
