/**
 * What the generated DTOs accept, run at runtime on comb's real column helpers: each schema is
 * imported and parsed, so a rule is judged by the value it takes, not by the text it emits.
 */
import fs from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as z from "zod"
import { readCombEntityMeta } from "../../../meta/read.ts"
import { analyze } from "../../analyzer.ts"
import { testContext } from "../__fixtures__/context.ts"
import { generateDtos } from "./generate.ts"

const CORE = path.join(import.meta.dirname, "../../../..")
let dir = ""
let person: Record<string, z.ZodType> = {}

const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
import * as z from "zod"
export const blobSchema = z.object({ s: z.string() })
export const team = sqliteTable("team", { id: c.id("tm") })
export const org = sqliteTable("org", { id: c.id("org") })
export const person = sqliteTable("person", {
	id: c.id("per"),
	slug: c.text("slug", { nomutate: true }).notNull(),
	externalId: c.text("external_id").notNull(),
	orgId: c.text("org_id").references(() => org.id),
	teamId: c.text("team_id", { mutable: true }).references(() => team.id),
	bornAt: c.timestamp("born_at"),
	email: c.text("email", { email: true }),
	site: c.text("site", { url: true }),
	createdAt: c.timestamp("created_at").notNull(),
	updatedAt: c.updatedAt("updated_at"),
	blob: c.json("blob", blobSchema, { maxBytes: 20 }),
})
`

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(CORE, ".tmp-dto-fields-"))
	const tablesPath = path.join(dir, "db.test.tables.ts")
	fs.writeFileSync(tablesPath, TABLES)
	generateDtos(testContext(analyze(tablesPath), { cwd: dir, tablesPath }), { output: path.join(dir, "dtos") })
	person = (await import(path.join(dir, "dtos", "person", "index.gen.ts"))) as Record<string, z.ZodType>
}, 60_000)
afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

const schema = (name: string) => person[`personDto${name}Schema`] as z.ZodType
const accepts = (name: string, value: object) => schema(name).safeParse(value).success
const CREATE = { createdAt: 1, externalId: "e", slug: "s" }
const ROW = {
	...CREATE,
	blob: null,
	bornAt: null,
	email: null,
	id: "per_1",
	orgId: null,
	site: null,
	teamId: null,
	updatedAt: 1,
}

describe("generated DTOs on comb's own columns", () => {
	it("keeps a nomutate column on create, which it must be given, and leaves it off update (F9)", () => {
		expect(accepts("Create", { createdAt: 1, externalId: "e" })).toBe(false)
		expect(accepts("Create", CREATE)).toBe(true)
		expect(Object.keys((schema("Update") as z.ZodObject).shape)).not.toContain("slug")
	})

	it("gives the id rules to a key and a reference to one, never to a text column by its name (F10)", () => {
		const digest = "a".repeat(64)
		expect(accepts("Create", { ...CREATE, externalId: digest })).toBe(true)
		expect(accepts("Read", { ...ROW, externalId: digest })).toBe(true)
		expect(accepts("Create", { ...CREATE, teamId: "tm 1" })).toBe(false)
		expect(accepts("Create", { ...CREATE, teamId: "t".repeat(49) })).toBe(false)
	})

	it("keeps a reference out of update and in immutable, unless it declares mutable (F25)", () => {
		const update = Object.keys((schema("Update") as z.ZodObject).shape)
		expect(update).not.toContain("orgId")
		expect(schema("Update").parse({ orgId: "org_2" })).toEqual({})
		expect(update).toContain("teamId")
		expect(schema("Update").parse({ teamId: "tm_2" })).toEqual({ teamId: "tm_2" })
		const meta = readCombEntityMeta(z.toJSONSchema(schema("Read"), { unrepresentable: "any" }))
		expect(meta?.immutable).toContain("orgId")
		expect(meta?.immutable).not.toContain("teamId")
	})

	it("publishes a JSON column's byte limit in its JSON Schema, as its refine enforces it (F26)", () => {
		const published = z.toJSONSchema(schema("Create"), { io: "input", unrepresentable: "any" }) as {
			properties: Record<string, { anyOf?: Array<Record<string, unknown>> }>
		}
		expect(published.properties["blob"]?.anyOf?.[0]).toMatchObject({
			description: "At most 20 bytes when serialized as JSON",
			"x-comb-maxBytes": 20,
		})
		expect(accepts("Create", { ...CREATE, blob: { s: "x".repeat(30) } })).toBe(false)
	})

	it("takes a c.timestamp before 1970 on create and read (F11)", () => {
		expect(accepts("Create", { ...CREATE, bornAt: -86_400_000 })).toBe(true)
		expect(accepts("Read", { ...ROW, bornAt: -86_400_000 })).toBe(true)
	})

	it("reads back an email or URL another rule stored, and checks the format only on a write (F12)", () => {
		expect(accepts("Read", { ...ROW, email: "ann@localhost", site: "example.com" })).toBe(true)
		expect(accepts("Create", { ...CREATE, email: "ann@localhost" })).toBe(false)
		expect(accepts("Create", { ...CREATE, site: "example.com" })).toBe(false)
	})

	it("keeps a column named createdAt that nothing fills on create, and leaves the helper's own off (F13)", () => {
		expect(accepts("Create", { externalId: "e", slug: "s" })).toBe(false)
		expect(Object.keys((schema("Create") as z.ZodObject).shape)).not.toContain("updatedAt")
	})
})
