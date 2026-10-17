/**
 * Generated DTOs, imported and run. Every documented column form must load, and its schemas
 * must accept and reject what the column does.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { readCombEntityMeta } from "../../../src/meta.ts"
import { cleanGeneratedDtos, type GeneratedEntity, generatedDtos } from "../support/dtos.ts"

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
