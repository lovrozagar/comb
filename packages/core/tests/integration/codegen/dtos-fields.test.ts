/**
 * Generated DTOs, imported and run. Every documented column form must load, and its schemas
 * must accept and reject what the column does.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { readCombEntityMeta } from "../../../src/meta.ts"
import fs from "node:fs"
import path from "node:path"
import { cleanGeneratedDtos, type GeneratedEntity, generatedDir, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const keys = (schema: z.ZodObject | undefined) => Object.keys(schema?.shape ?? {}).sort()

describe("private columns (M-H2)", () => {
	const tables = `export const settingsSchema = z.object({ theme: z.string() })
export const wallet = sqliteTable("wallet", {
	id: c.id("wal"),
	owner_id: c.ref("owner_id", { private: true }).references(() => wallet.id),
	risk_score: c.integer("risk_score", { private: true }),
	_internal_count: c.integer("_internal_count"),
	is_flagged: c.boolean("is_flagged"),
	secret_tier: c.text("secret_tier", { private: true }),
	_hidden_kind: c.enum("_hidden_kind", ["a", "b"]),
	settings: c.json("settings", settingsSchema, { private: true }),
})`

	let wallet: GeneratedEntity

	it("keep every private column of every type out of the read DTOs and the stamp", async () => {
		wallet = (await generatedDtos("private", `import * as z from "zod"\n${tables}`)).wallet as GeneratedEntity
		expect(keys(wallet.walletDtoReadSchema)).toEqual(["id", "is_flagged"])
		expect(keys(wallet.walletDtoReadPartialSchema)).toEqual(["id", "is_flagged"])
		const stamp = readCombEntityMeta(z.toJSONSchema(wallet.walletDtoReadSchema as z.ZodObject))
		expect(stamp?.immutable).not.toContain("owner_id")
		expect(JSON.stringify(stamp)).not.toMatch(/owner_id|risk_score|secret_tier|_internal_count|hidden_kind|settings/)
	})
})

describe("enum columns (M-H3, M-H4)", () => {
	const MACHINE = `{ initial: "queued", terminal: ["sent"], transitions: { queued: ["sending"], sending: ["sent"] } }`

	it.each([
		["inline with a state machine", `c.enum("status", ["queued", "sending", "sent"], ${MACHINE}).notNull()`, ""],
		["with as const", `c.enum("status", ["queued", "sending", "sent"] as const).notNull()`, ""],
		["across lines", `c.enum("status", [\n\t\t"queued",\n\t\t"sending",\n\t\t"sent",\n\t]).notNull()`, ""],
		[
			"from a local const",
			`c.enum("status", STATUSES).notNull()`,
			`export const STATUSES = ["queued", "sending", "sent"] as const`,
		],
		[
			"from a machine const (state-machines §4)",
			`c.enum("status", deliveryStates.values, deliveryStates).notNull()`,
			`const deliveryStates = { values: ["queued", "sending", "sent"], ...${MACHINE} } as const`,
		],
		["from an imported const", `c.enum("status", STATUSES).notNull()`, `import { STATUSES } from "./enums"`],
	])("generate a working z.enum %s", async (name, column, before) => {
		const tables = `${before}\nexport const delivery = sqliteTable("delivery", { id: c.id("dlv"), status: ${column} })`
		const files = { "enums.ts": `export const STATUSES = ["queued", "sending", "sent"] as const\n` }
		const delivery = (await generatedDtos(`enum-${name.replace(/\W+/g, "-")}`, tables, { files })).delivery
		const read = delivery?.deliveryDtoReadSchema as z.ZodObject
		expect(read.safeParse({ id: "dlv_1", status: "queued" }).success).toBe(true)
		expect(read.safeParse({ id: "dlv_1", status: "bogus" }).success).toBe(false)
		const create = delivery?.deliveryDtoCreateSchema as z.ZodObject
		expect(create.safeParse({ status: "bogus" }).success).toBe(false)
	})

	it("publish the same values in the stamp and the schema", async () => {
		const tables = `export const delivery = sqliteTable("delivery", { id: c.id("dlv"), status: c.enum("status", ["queued", "sending", "sent"], ${MACHINE}).notNull() })`
		const read = (await generatedDtos("enum-stamp", tables)).delivery?.deliveryDtoReadSchema as z.ZodObject
		const json = z.toJSONSchema(read) as { properties: Record<string, { enum?: string[] }> }
		expect(json.properties.status?.enum).toEqual(["queued", "sending", "sent"])
		expect(readCombEntityMeta(json)?.states?.values).toEqual(["queued", "sending", "sent"])
	})

	it("share one inline enum across tables without referencing anything undefined", async () => {
		const tables = `export const PRIORITIES = ["low", "high"] as const
export const a = sqliteTable("a", { id: c.id("aaa"), priority: c.enum("priority", PRIORITIES).notNull() })
export const b = sqliteTable("b", { id: c.id("bbb"), priority: c.enum("priority", PRIORITIES).notNull() })
export const d = sqliteTable("d", { id: c.id("ddd"), priority: c.enum("priority", PRIORITIES).notNull() })`
		const generated = await generatedDtos("enum-shared", tables)
		for (const [entity, schema] of [
			["a", "aDtoReadSchema"],
			["b", "bDtoReadSchema"],
			["d", "dDtoReadSchema"],
		] as const) {
			const read = generated[entity]?.[schema] as z.ZodObject
			expect(read.safeParse({ id: "x", priority: "high" }).success).toBe(true)
			expect(read.safeParse({ id: "x", priority: "mid" }).success).toBe(false)
		}
	})
})

describe("timestamp-named columns of another type (M-M8)", () => {
	it("validate a text created_at as text", async () => {
		const tables = `export const event = sqliteTable("event", { id: c.id("evt"), created_at: c.text("created_at").notNull() })`
		const read = (await generatedDtos("text-timestamps", tables)).event?.eventDtoReadSchema as z.ZodObject
		expect(read.safeParse({ created_at: "2026-01-01T00:00:00Z", id: "evt_1" }).success).toBe(true)
	})
})

describe("numeric bounds (REVIEW 3.2)", () => {
	const tables = `export const reading = sqliteTable("reading", {
	id: c.id("rdg"),
	temp: c.integer("temp", { min: -40, max: 60 }),
	floor: c.integer("floor", { min: -3 }),
	cap: c.integer("cap", { max: 9 }),
	lat: c.real("lat", { min: -90.5, max: 90.5 }),
	depth: c.real("depth", { min: -0.25 }),
	ratio: c.real("ratio", { max: 1.5 }),
})`

	it("reach the schema for integers and reals: negative, fractional, min only, max only, both", async () => {
		const reading = (await generatedDtos("bounds", tables)).reading as GeneratedEntity
		const shape = (reading.readingDtoCreateSchema as z.ZodObject).shape as Record<string, z.ZodType>
		const accepts = (column: string, value: number) => shape[column]?.safeParse(value).success
		const verdicts = (column: string, values: number[]) => values.map((value) => accepts(column, value))

		expect(verdicts("temp", [-41, -40, 60, 61])).toEqual([false, true, true, false])
		expect(verdicts("floor", [-4, -3, 1_000_000])).toEqual([false, true, true])
		expect(verdicts("cap", [-1, 0, 9, 10])).toEqual([false, true, true, false])
		expect(verdicts("lat", [-90.6, -90.5, 90.5, 90.6])).toEqual([false, true, true, false])
		expect(verdicts("depth", [-0.26, -0.25, 1e9])).toEqual([false, true, true])
		expect(verdicts("ratio", [-1e9, 1.5, 1.51])).toEqual([true, true, false])
	})
})

describe("what the 0.8.0 codegen review found in the generated DTOs (F4, F5, F6, F17)", () => {
	it("fails on a column spread it cannot read, naming the file and line, rather than dropping its columns (F4)", async () => {
		const tables = `const auditCols = () => ({ note: c.text("note") })
const sharedCols = { ...auditCols() }
export const memo = sqliteTable("memo", { id: c.id("mem"), ...sharedCols })`
		await expect(generatedDtos("spread", tables)).rejects.toThrow(
			/db\.x\.tables\.ts:4: comb cannot read the columns of \.\.\.auditCols\(\)/,
		)
	})

	it("names each timestamp as the table declares it, never by a table-wide style (F5)", async () => {
		const tables = `export const post = sqliteTable("post", {
	id: c.id("pst"),
	title: c.text("title").notNull(),
	created_at: c.createdAt("created_at"),
	updatedAt: c.updatedAt("updated_at"),
})`
		const post = (await generatedDtos("timestamps", tables)).post as GeneratedEntity
		expect(keys(post.postDtoReadSchema)).toEqual(["created_at", "id", "title", "updatedAt"])
		expect(post.postDtoReadSchema?.safeParse({ created_at: 1, id: "pst_1", title: "t", updatedAt: 2 }).success).toBe(
			true,
		)
		expect(keys(post.postDtoCreateSchema)).toEqual(["title"])
	})

	it("points softDelete at the column's property name, as every other key of the meta does (F6)", async () => {
		const tables = `export const account = sqliteTable("account", {
	id: c.id("acc"),
	created_at: c.createdAt("created_at"),
	deletedAt: c.deletedAt("deleted_at"),
})`
		const account = (await generatedDtos("soft-delete", tables)).account as GeneratedEntity
		expect(readCombEntityMeta(z.toJSONSchema(account.accountDtoReadSchema as z.ZodObject))?.softDelete).toBe(
			"deletedAt",
		)
	})
})

describe("the _shared file of the generated DTOs (F17)", () => {
	it("emits only what a generated DTO imports, and what those need", async () => {
		const tables = `export const post = sqliteTable("post", {
	id: c.id("pst"),
	title: c.text("title").notNull(),
	createdAt: c.createdAt("created_at"),
	updatedAt: c.updatedAt("updated_at"),
})`
		await generatedDtos("shared", tables)
		const dtos = path.join(generatedDir("shared"), "dtos")
		const shared = fs.readFileSync(path.join(dtos, "_shared", "index.gen.ts"), "utf8")
		const exported = [...shared.matchAll(/^export const (\w+)/gm)].map((match) => match[1] as string)
		const entity = fs.readFileSync(path.join(dtos, "post", "index.gen.ts"), "utf8")
		const imported = new Set(
			(/import \{([^}]*)\} from "\.\.\/_shared/.exec(entity)?.[1] ?? "").split(",").map((n) => n.trim()),
		)
		/* an export no DTO imports is there only for an export a DTO does import */
		const unused = exported.filter(
			(name) =>
				!imported.has(name) &&
				!shared.includes(`${name}.`) &&
				!new RegExp(`\\b${name}\\b[^\\n]*$`).test(shared.split(`export const ${name}`)[1] ?? ""),
		)
		expect(exported.filter((name) => /^validateTimestamps|Refinements/.test(name))).toEqual([])
		expect(exported).not.toContain("timestampNullableSchema")
		expect(unused.filter((name) => !shared.slice(shared.indexOf(`export const ${name}`) + 1).includes(name))).toEqual(
			[],
		)
	})
})

describe("an email column's DTO (F15)", () => {
	it("trims and lowercases before it validates, and still publishes the email format and bounds", async () => {
		const tables = `export const member = sqliteTable("member", { id: c.id("mem"), email: c.text("email", { email: true, max: 254, min: 5 }).notNull() })`
		const member = (await generatedDtos("email-format", tables)).member as GeneratedEntity
		const create = member.memberDtoCreateSchema as z.ZodObject
		expect(create.safeParse({ email: " Ann@Example.COM " })).toMatchObject({
			data: { email: "ann@example.com" },
			success: true,
		})
		expect(create.safeParse({ email: "nope" }).success).toBe(false)
		const published = z.toJSONSchema(create, { io: "input" }) as { properties: Record<string, Record<string, unknown>> }
		expect(published.properties["email"]).toMatchObject({ format: "email", maxLength: 254, minLength: 5 })
	})
})
