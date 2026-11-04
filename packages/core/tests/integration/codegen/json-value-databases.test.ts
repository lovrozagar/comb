/**
 * A2-1 of r22: a plain JSON value's definition is comb's, not a database's. Each database's
 * `_shared` module defined its own `CombJsonValue`, so one JSON Schema run over the DTOs of two
 * databases, as an app's one OpenAPI document is, threw on the id zod saw twice.
 */
import path from "node:path"
import * as z from "zod"
import { describe, expect, it } from "vitest"
import { codegen, generatedFiles, project, useProjects } from "../support/codegen-project.ts"

useProjects()

const CONFIG = `export default { databases: {
	core: { dialect: "postgres", tables: "./db.core.tables.ts" },
	logs: { dialect: "postgres", tables: "./db.logs.tables.ts" },
} }
`

const tables = (name: string) => `import { jsonb, pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
export const ${name} = pgTable("${name}", { id: c.id("${name.slice(0, 3)}"), raw: jsonb("raw") })
`

/** The `schema` export of the generated entity module of `name` in `dir` */
async function entity(dir: string, name: string, schema: string): Promise<z.ZodType> {
	const file = generatedFiles(dir).find(
		(each) => each.includes("dtos") && !each.includes("_shared") && path.basename(each).includes(name),
	)
	expect(file, name).toBeDefined()
	return ((await import(path.join(dir, file as string))) as Record<string, z.ZodType>)[schema] as z.ZodType
}

describe("a plain JSON value across two databases (A2-1)", () => {
	it("publishes one CombJsonValue in one document over both", async () => {
		const dir = project({
			"comb.config.ts": CONFIG,
			"db.core.tables.ts": tables("post"),
			"db.logs.tables.ts": tables("event"),
		})
		await codegen(dir, ["-g", "dtos"])
		const shared = generatedFiles(dir).filter((file) => file.includes("_shared"))
		expect(shared.length).toBeGreaterThan(1)
		const both = z.object({
			event: await entity(dir, "event", "eventDtoCreateSchema"),
			post: await entity(dir, "post", "postDtoCreateSchema"),
		})
		const published = JSON.stringify(z.toJSONSchema(both, { io: "input" }))
		expect(Object.keys((JSON.parse(published) as { $defs: object }).$defs)).toEqual(["CombJsonValue"])
		expect(published.match(/#\/\$defs\/CombJsonValue/g)?.length).toBeGreaterThanOrEqual(2)
	}, 120_000)
})
