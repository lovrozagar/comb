/**
 * The 0.13.0 round's F65: a read never refuses a stored row, so a read DTO states each bound the app
 * declares as `x-comb-*` meta and enforces only what the engine itself holds a column to: a Postgres
 * varchar's length and int2 or int4's range. A write DTO still enforces every bound.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const COLUMNS = `name: c.text("name", { min: 3, max: 10 }).notNull(),
	email: c.text("email", { email: true, max: 20 }).notNull(),
	qty: c.integer("qty", { min: 0, max: 10 }).notNull(),
	ratio: c.real("ratio", { min: 0, max: 1 }).notNull(),
	at: c.timestamp("at", { min: 0, max: 1000 }).notNull(),`

/* a row an older rule, a migration or an import stored past every declared bound */
const STORED = {
	at: 5000,
	email: "someone.long@example.com",
	id: `row_${"a".repeat(60)}`,
	name: "an eleven+ name",
	qty: 99,
	ratio: 2,
}

/* each declared bound as the read DTO publishes it */
const DECLARED = {
	at: { "x-comb-maximum": 1000, "x-comb-minimum": 0 },
	email: { "x-comb-maxLength": 20 },
	id: { "x-comb-maxLength": 48, "x-comb-minLength": 1 },
	name: { "x-comb-maxLength": 10, "x-comb-minLength": 3 },
	qty: { "x-comb-maximum": 10, "x-comb-minimum": 0 },
	ratio: { "x-comb-maximum": 1, "x-comb-minimum": 0 },
}

type Dtos = { create: z.ZodObject; read: z.ZodObject; readPartial: z.ZodObject }

const dtosOf = (entity: Record<string, z.ZodObject> | undefined): Dtos => ({
	create: entity?.["rowDtoCreateSchema"] as z.ZodObject,
	read: entity?.["rowDtoReadSchema"] as z.ZodObject,
	readPartial: entity?.["rowDtoReadPartialSchema"] as z.ZodObject,
})

/** The JSON Schema a read DTO publishes for each of its properties */
const published = (schema: z.ZodObject) =>
	(z.toJSONSchema(schema, { io: "output" }) as { properties: Record<string, Record<string, unknown>> }).properties

/** Whether `schema` accepts `value`, by the keywords a read DTO's float publishes: type, enum and anyOf */
function accepts(schema: Record<string, unknown>, value: unknown): boolean {
	const branches = schema["anyOf"] as Array<Record<string, unknown>> | undefined
	if (branches !== undefined) return branches.some((branch) => accepts(branch, value))
	const type = schema["type"]
	const typed = type === undefined || (value === null ? type === "null" : typeof value === type)
	const listed = schema["enum"] === undefined || (schema["enum"] as unknown[]).includes(value)
	return typed && listed
}

for (const dialect of ["sqlite", "postgres"] as const) {
	describe(`a read DTO's declared bounds on ${dialect} (F65)`, () => {
		const table = dialect === "postgres" ? "pgTable" : "sqliteTable"
		const load = async (name: string, columns: string, head = "") =>
			dtosOf(
				(
					await generatedDtos(
						`f65-${name}-${dialect}`,
						`${head}export const row = ${table}("row", { id: c.id("row"), ${columns} })`,
						{ dialect },
					)
				)["row"],
			)

		it("parses a stored row past each of them, and publishes each as x-comb meta", async () => {
			const { read, readPartial } = await load("declared", COLUMNS)
			expect(read.safeParse(STORED).success).toBe(true)
			expect(readPartial.safeParse(STORED).success).toBe(true)
			const properties = published(read)
			for (const [key, meta] of Object.entries(DECLARED)) {
				expect(properties[key]).toMatchObject(meta)
				/* a declared bound is never the enforced one; an integer keeps what its column holds */
				for (const [rule, bound] of Object.entries(meta))
					expect(properties[key]?.[rule.slice("x-comb-".length)]).not.toBe(bound)
			}
		})

		/*
		 * 27.12 of plan 15: a stored ±Infinity reads back, and JSON writes it as null, so the published
		 * schema takes the null a client is sent; NaN, which no JSON Schema holds, still fails the read
		 */
		it("publishes a float's read as a number or the null JSON writes an infinity as", async () => {
			const { read } = await load("float", COLUMNS)
			const ratio = published(read)["ratio"] as Record<string, unknown>
			expect(ratio["anyOf"]).toEqual([{ type: "number" }, { type: "null" }])
			expect(accepts(ratio, null)).toBe(true)
			expect(accepts(ratio, 0.5)).toBe(true)
			expect(accepts(ratio, "0.5")).toBe(false)
			const row = { ...STORED, ratio: Number.POSITIVE_INFINITY }
			expect(read.safeParse(row).success).toBe(true)
			expect(read.safeParse({ ...row, ratio: Number.NEGATIVE_INFINITY }).success).toBe(true)
			expect(read.safeParse({ ...row, ratio: Number.NaN }).success).toBe(false)
			/* D1 hands an infinity back as null, so a read takes it (27.18 of plan 15, tests/integration/d1/read-float.test.ts) */
			expect(read.safeParse({ ...row, ratio: null }).success).toBe(true)
		})

		it("refuses each of them on a write", async () => {
			const { create } = await load("write", COLUMNS)
			const valid = { at: 500, email: "a@example.com", name: "fine", qty: 5, ratio: 0.5 }
			expect(create.safeParse(valid).success).toBe(true)
			for (const key of Object.keys(valid))
				expect(create.safeParse({ ...valid, [key]: STORED[key as keyof typeof STORED] }).success).toBe(false)
		})
	})
}

describe("a read DTO's engine bounds (F65)", () => {
	it("on SQLite, a text length is meta, as SQLite never holds a column to it", async () => {
		const { read } = dtosOf(
			(
				await generatedDtos(
					"f65-length-sqlite",
					`import { text } from "drizzle-orm/sqlite-core"
export const row = sqliteTable("row", { id: c.id("row"), code: text("code", { length: 4 }).notNull() })`,
				)
			)["row"],
		)
		expect(read.safeParse({ code: "longer than four", id: "row_1" }).success).toBe(true)
		expect(published(read)["code"]).toMatchObject({ "x-comb-maxLength": 4 })
	})

	it("on Postgres, a varchar's length and int4's range stay enforced, as no stored row exceeds them", async () => {
		const { read } = dtosOf(
			(
				await generatedDtos(
					"f65-engine-postgres",
					`import { varchar } from "drizzle-orm/pg-core"
export const row = pgTable("row", { id: c.id("row"), code: varchar("code", { length: 4 }).notNull(), qty: c.integer("qty", { max: 10 }).notNull() })`,
					{ dialect: "postgres" },
				)
			)["row"],
		)
		expect(read.safeParse({ code: "abcd", id: "row_1", qty: 2 ** 31 - 1 }).success).toBe(true)
		expect(read.safeParse({ code: "abcde", id: "row_1", qty: 1 }).success).toBe(false)
		expect(read.safeParse({ code: "abcd", id: "row_1", qty: 2 ** 31 }).success).toBe(false)
		expect(published(read)["code"]).toMatchObject({ maxLength: 4 })
		expect(published(read)["qty"]).toMatchObject({ maximum: 2147483647, "x-comb-maximum": 10 })
	})
})
