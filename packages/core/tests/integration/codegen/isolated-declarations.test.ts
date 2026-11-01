/**
 * K17 of r17: a consumer may compile under `isolatedDeclarations`, which takes no inferred type of an
 * export. The generated functions and records annotate their types, so the enum checks and the
 * column records compile there. The zod DTOs, whose types zod infers by design, and the consumer's
 * own tables are outside it.
 */
import { describe, expect, it } from "vitest"
import { codegen, generatedFiles, project, typecheck, useProjects } from "../support/codegen-project.ts"

useProjects()

const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
export const user = sqliteTable("user", { id: c.id("usr"), name: c.text("name"), role: c.enum("role", ["admin", "member"]).notNull() })
export const post = sqliteTable("post", { id: c.id("pst"), state: c.enum("state", ["draft", "live"]), "title-x": c.text("title_x") })
`

/*
 * the generated files whose exports are plain functions and records, which annotate their types: the
 * kinds README and meta-contract §10 name as isolatedDeclarations-clean (C7 = K8 of r18)
 */
const IN_SCOPE =
	/(?:constraints|entities|enum-checks|error-keys|field-names|rows|rqb-cols|sql-cols|table-names)[^:]*\.gen\.ts/

describe("generated functions and records under isolatedDeclarations (K17)", () => {
	it("compile, each export's type annotated", async () => {
		const dir = project({ "src/db/db.core.tables.ts": TABLES })
		await codegen(dir, ["--tables", "src/db/db.core.tables.ts"])
		const output = typecheck(dir, [], { declaration: true, isolatedDeclarations: true })
		const scoped = output.split("\n").filter((line) => IN_SCOPE.test(line))
		expect(scoped).toEqual([])
		/* the files were there to check */
		expect(generatedFiles(dir).filter((file) => IN_SCOPE.test(file)).length).toBeGreaterThanOrEqual(9)
		/* C7 = K8 of r18: _shared's example arrays are literal, so none of its errors is TS9017; its zod values stay inferred */
		expect(output.split("\n").filter((line) => line.includes("_shared") && line.includes("TS9017"))).toEqual([])
	}, 240_000)
})
