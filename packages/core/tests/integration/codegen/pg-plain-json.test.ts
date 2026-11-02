/**
 * C5 of r19: a plain json or jsonb column's write DTO takes null only where the column does. z.json()
 * admits null, so a NOT NULL column's DTO took a body Postgres refuses with a 23502, and published
 * null on a required field; a nullable one published a union nested in a union, null twice.
 */
import * as z from "zod"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"
import { usePg } from "../support/pg.ts"

afterAll(() => cleanGeneratedDtos())

const TABLE = `import { json, jsonb, text } from "drizzle-orm/pg-core"
export const row = pgTable("row", {
	id: text("id").primaryKey(),
	req: json("req").notNull(),
	opt: json("opt"),
	reqb: jsonb("reqb").notNull(),
	optb: jsonb("optb"),
})`

/** The row's generated create DTO */
async function createDto(): Promise<z.ZodObject> {
	const dtos = await generatedDtos("c5", TABLE, { dialect: "postgres" })
	return dtos["row"]?.["rowDtoCreateSchema"] as z.ZodObject
}

const BODY = { id: "a", opt: null, optb: null, req: { a: 1 }, reqb: [1, "two", null] }
type Published = { anyOf?: Published[]; type?: string }

/** How many times `schema` admits null as the value itself, through its unions, never inside an array or object */
const nulls = (schema: Published): number =>
	schema.type === "null" ? 1 : (schema.anyOf ?? []).reduce((count, member) => count + nulls(member), 0)

/** What the create DTO publishes for `key` */
const published = (dto: z.ZodObject, key: string) => z.toJSONSchema(dto, { io: "input" }).properties?.[key] as Published

describe("a plain json column's write DTO", () => {
	const sessions = usePg()

	it.each(["req", "reqb"])("refuses null for the NOT NULL %s, as Postgres does, and publishes none", async (key) => {
		const dto = await createDto()
		expect(dto.safeParse({ ...BODY, [key]: null }).success).toBe(false)
		expect(nulls(published(dto, key))).toBe(0)
		await sessions.pg().query(`CREATE TEMP TABLE row (id text PRIMARY KEY, ${key} json NOT NULL)`)
		await expect(sessions.pg().query(`INSERT INTO row VALUES ('a', NULL)`)).rejects.toMatchObject({ code: "23502" })
	})

	it.each(["opt", "optb"])("takes null for the nullable %s, published once", async (key) => {
		const dto = await createDto()
		expect(dto.safeParse({ ...BODY, [key]: null }).success).toBe(true)
		expect(nulls(published(dto, key))).toBe(1)
	})

	it("takes every JSON value a column holds, its nested nulls included", async () => {
		const dto = await createDto()
		for (const value of ["text", 1.5, true, [1, null], { a: null }, []])
			expect(dto.safeParse({ ...BODY, req: value }).success, JSON.stringify(value)).toBe(true)
	})
})
