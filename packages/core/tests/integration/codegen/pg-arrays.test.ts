/**
 * F49 of the 0.13.0 round: a Postgres array column carries its element's data type and its
 * dimensions, so codegen types it as its element in an array per dimension, each element nullable
 * as Postgres stores it, and every DTO agrees with what Postgres takes and gives back.
 */
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import type * as z from "zod"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"
import { usePg } from "../support/pg.ts"

afterAll(() => cleanGeneratedDtos())

const COLUMNS = `{ id: c.id("bag"), tags: text("tags").array().notNull(), scores: integer("scores").array(), grid: integer("grid").array("[][]") }`
const bag = pgTable("bag", {
	grid: integer("grid").array("[][]"),
	id: text("id").primaryKey(),
	scores: integer("scores").array(),
	tags: text("tags").array().notNull(),
})
const BODY = {
	grid: [
		[1, 2],
		[3, null],
	],
	scores: [1, null, 3],
	tags: ["a", "b"],
}

/** The bag's generated create and read DTOs */
async function bagDtos(): Promise<{ create: z.ZodObject; read: z.ZodObject }> {
	const dtos = await generatedDtos(
		"f49",
		`import { integer, text } from "drizzle-orm/pg-core"\nexport const bag = pgTable("bag", ${COLUMNS})`,
		{ dialect: "postgres" },
	)
	return {
		create: dtos["bag"]?.["bagDtoCreateSchema"] as z.ZodObject,
		read: dtos["bag"]?.["bagDtoReadSchema"] as z.ZodObject,
	}
}

describe("a Postgres array column's write DTO (F49)", () => {
	it("takes an array per dimension, and refuses a scalar, a ragged grid and a bad element", async () => {
		const { create } = await bagDtos()
		expect(create.safeParse(BODY).success).toBe(true)
		/* a ragged grid Postgres refuses ("matching dimensions") is a 400 here, not a 500 there */
		for (const bad of [
			{ tags: "a" },
			{ scores: 1 },
			{ grid: [1, 2] },
			{ grid: [[1], [2, 3]] },
			{ scores: [1.5] },
			{ tags: ["a\u0000"] },
		])
			expect(create.safeParse({ ...BODY, ...bad }).success, JSON.stringify(bad)).toBe(false)
	})
})

describe("a Postgres array column, stored and read back (F49)", () => {
	const sessions = usePg()
	let create: z.ZodObject
	let read: z.ZodObject

	beforeAll(async () => {
		;({ create, read } = await bagDtos())
	})

	beforeEach(async () => {
		await sessions
			.pg()
			.query("CREATE TEMP TABLE bag (id text PRIMARY KEY, tags text[] NOT NULL, scores integer[], grid integer[][])")
	})

	/** The row of `id`, as node-postgres reads it */
	const rowOf = async (id: string) => (await sessions.pg().query("SELECT * FROM bag WHERE id = $1", [id])).rows[0]

	it("stores what it takes, and reads back what Postgres stores, NULL and empty elements included", async () => {
		const values = create.parse(BODY) as { grid: number[][]; scores: number[]; tags: string[] }
		const [row] = await drizzle({ client: sessions.pg() })
			.insert(bag)
			.values({ id: "bag_1", ...values })
			.returning()
		expect(row).toMatchObject(BODY)
		expect(read.safeParse(row).success).toBe(true)
		await sessions.pg().query("INSERT INTO bag VALUES ('bag_2', '{NULL,\"\"}', '{}', NULL)")
		const stored = await rowOf("bag_2")
		expect(stored).toMatchObject({ grid: null, scores: [], tags: [null, ""] })
		expect(read.safeParse(stored).success).toBe(true)
	})

	it("reads a deeper value than the column declares, as Postgres keeps no declared dimensions", async () => {
		await sessions.pg().query("INSERT INTO bag VALUES ('bag_3', '{{a,b},{c,NULL}}', '{{1},{2}}', '{1,2}')")
		const deep = await rowOf("bag_3")
		expect(deep).toMatchObject({
			scores: [[1], [2]],
			tags: [
				["a", "b"],
				["c", null],
			],
		})
		expect(read.safeParse(deep).success).toBe(true)
		await expect(
			sessions.pg().query("INSERT INTO bag VALUES ('bag_4', '{a}', NULL, ARRAY[ARRAY[1], ARRAY[2, 3]])"),
		).rejects.toThrow(/matching dimensions/)
	})
})
