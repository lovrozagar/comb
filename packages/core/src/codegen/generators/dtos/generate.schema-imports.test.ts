/**
 * F1, F2 of the 0.14.1 review: the c.json schemas a table imports are each its own module's, whatever
 * their export names, run at runtime on the generated module: two modules' `profile`, and a schema
 * named as a generated file names its own (`z`, `combMeta`, `_str`).
 */
import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type * as z from "zod"
import { analyze } from "../../analyzer.ts"
import { testContext } from "../__fixtures__/context.ts"
import { generateDtos } from "./generate.ts"

const CORE = path.join(import.meta.dirname, "../../../..")
let dir = ""
let account: Record<string, z.ZodType> = {}

const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
import { profile as homeProfile } from "./home/schemas.ts"
import { profile as workProfile } from "./work/schemas.ts"
import { _str as tag, combMeta as note, z as zone } from "./named/schemas.ts"
export const account = sqliteTable("account", {
	id: c.id("acc"),
	home: c.json("home", homeProfile).notNull(),
	work: c.json("work", workProfile).notNull(),
	tag: c.json("tag", tag).notNull(),
	note: c.json("note", note).notNull(),
	zone: c.json("zone", zone).notNull(),
})
`

const MODULES: Record<string, string> = {
	"home/schemas.ts": 'import * as z from "zod"\nexport const profile = z.object({ street: z.string() })\n',
	"named/schemas.ts":
		'import * as zod from "zod"\nexport const _str = zod.object({ t: zod.string() })\nexport const combMeta = zod.object({ n: zod.number() })\nexport const z = zod.object({ tz: zod.string() })\n',
	"work/schemas.ts": 'import * as z from "zod"\nexport const profile = z.object({ desk: z.number() })\n',
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(CORE, ".tmp-dto-schema-imports-"))
	for (const [name, source] of Object.entries(MODULES)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
		fs.writeFileSync(path.join(dir, name), source)
	}
	const tablesPath = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(tablesPath, TABLES)
	generateDtos(testContext(analyze(tablesPath), { cwd: dir, tablesPath }), { output: path.join(dir, "dtos") })
	account = (await import(path.join(dir, "dtos", "account", "index.gen.ts"))) as Record<string, z.ZodType>
}, 60_000)
afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

const create = (row: Record<string, unknown>) => account["accountDtoCreateSchema"]?.safeParse(row).success
const NAMED = { note: { n: 1 }, tag: { t: "x" }, zone: { tz: "UTC" } }

describe("generated DTOs: each c.json column's own schema", () => {
	it("validates two modules' same-named schemas each against its own column", () => {
		expect(create({ ...NAMED, home: { street: "Main" }, work: { desk: 4 } })).toBe(true)
		expect(create({ ...NAMED, home: { desk: 4 }, work: { street: "Main" } })).toBe(false)
	})

	it("imports a schema named as the generated file names its own, and validates its column", () => {
		const home = { street: "Main" }
		const work = { desk: 4 }
		expect(create({ home, note: { n: 1 }, tag: { t: "x" }, work, zone: { tz: "UTC" } })).toBe(true)
		expect(create({ home, note: { n: "one" }, tag: { t: "x" }, work, zone: { tz: "UTC" } })).toBe(false)
		expect(create({ home, note: { n: 1 }, tag: { t: 1 }, work, zone: { tz: "UTC" } })).toBe(false)
	})
})
