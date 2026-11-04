/**
 * A2-9 of r22: a Postgres array column's write DTO takes a null element only where the column's
 * drizzle type does. drizzle types `text().array()` as `string[]`, its element as `$type<E>()`
 * declares it, so a DTO that took null in every element output a value no insert of the table
 * took without a cast, and passed an app a null its own types said it never stores.
 */
import fs from "node:fs"
import path from "node:path"
import * as z from "zod"
import { describe, expect, it } from "vitest"
import { codegen, generatedFiles, project, typecheck, useProjects } from "../support/codegen-project.ts"

useProjects()

const CONFIG = `export default { databases: { core: { dialect: "postgres", tables: "./db.core.tables.ts" } } }
`

const TABLES = `import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
type Open = string | null
export const row = pgTable("row", {
	id: c.id("row"),
	tags: text("tags").array().notNull(),
	maybe: text("maybe").array(),
	open: text("open").array().$type<string | null>(),
	aliased: text("aliased").array().notNull().$type<Open>(),
	grid: integer("grid").array("[][]").notNull(),
	openGrid: integer("open_grid").array("[][]").$type<number | null>(),
})
`

/* what an app writes: the parsed body into the table's insert, each array key by its insert type */
const consumer = (module: string) => `import type * as z from "zod"
import type { row } from "./db.core.tables.ts"
import { rowDtoCreateSchema } from "${module}"
type Insert = typeof row.$inferInsert
type Created = z.output<typeof rowDtoCreateSchema>
export function insert(body: Created): Pick<Insert, "tags" | "maybe" | "open" | "aliased" | "grid" | "openGrid"> {
	return { tags: body.tags, maybe: body.maybe, open: body.open, aliased: body.aliased, grid: body.grid, openGrid: body.openGrid }
}
/* a declared null element stays one the DTO outputs */
export const open: Created["open"] = ["a", null]
export const aliased: Created["aliased"] = [null]
export const openGrid: Created["openGrid"] = [[1, null]]
`

/** The generated entity module of row in `dir`, its path from the project root */
const entityFile = (dir: string): string =>
	generatedFiles(dir).find(
		(each) => each.includes("dtos") && !each.includes("_shared") && path.basename(each).includes("row"),
	) as string

describe("a Postgres array column's element, as drizzle's type declares it (A2-9)", () => {
	it("outputs a create DTO an insert of the table takes, a declared null element kept", async () => {
		const dir = project({ "comb.config.ts": CONFIG, "db.core.tables.ts": TABLES })
		await codegen(dir, ["-g", "dtos"])
		const file = entityFile(dir)
		expect(file).toBeDefined()
		fs.writeFileSync(path.join(dir, "consumer.ts"), consumer(`./${file}`))
		expect(typecheck(dir, ["consumer.ts", "db.core.tables.ts"])).toBe("")

		const module = (await import(path.join(dir, file))) as Record<string, z.ZodObject>
		const create = module["rowDtoCreateSchema"] as z.ZodObject
		const read = module["rowDtoReadSchema"] as z.ZodObject
		const body = { aliased: ["a"], grid: [[1]], tags: ["a"] }
		expect(create.safeParse(body).success).toBe(true)
		/* an element the type says is never null is refused, as an app's insert would refuse it */
		expect(create.safeParse({ ...body, tags: ["a", null] }).success).toBe(false)
		expect(create.safeParse({ ...body, maybe: [null] }).success).toBe(false)
		expect(create.safeParse({ ...body, grid: [[1, null]] }).success).toBe(false)
		/* one the type admits is taken */
		expect(create.safeParse({ ...body, aliased: [null], open: ["a", null], openGrid: [[null]] }).success).toBe(true)
		/* a read never refuses a stored row, whatever the type says (F49) */
		const stored = {
			aliased: [null],
			grid: [[1, null]],
			id: "row_a",
			maybe: [null],
			open: null,
			openGrid: null,
			tags: [null],
		}
		expect(read.safeParse(stored).success).toBe(true)
	}, 120_000)

	/* A3-1 of r23: a JavaScript tables module declares no $type, so its element is as its builder types it */
	it.each(["db.core.tables.js", "db.core.tables.mjs"])(
		"generates from %s with an array column, allowJs false",
		async (file) => {
			const dir = project({
				"comb.config.ts": CONFIG.replace("./db.core.tables.ts", `./${file}`),
				[file]: `import { pgTable, text } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
export const row = pgTable("row", { id: c.id("row"), tags: text("tags").array().notNull() })
`,
				"tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: false } }),
			})
			await codegen(dir, ["-g", "dtos"])
			const module = (await import(path.join(dir, entityFile(dir)))) as Record<string, z.ZodObject>
			const create = module["rowDtoCreateSchema"] as z.ZodObject
			expect([create.safeParse({ tags: ["a"] }).success, create.safeParse({ tags: [null] }).success]).toEqual([
				true,
				false,
			])
		},
		120_000,
	)
})
