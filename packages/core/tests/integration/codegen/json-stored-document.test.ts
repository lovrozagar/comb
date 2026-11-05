/**
 * CD2 and CD3 of r22b: a `c.json` schema is the stored document. The write DTOs store the schema's
 * output and the read DTO parses the stored row with the same schema, so a schema whose output its
 * own input refuses (a transform, a pipe, a preprocess) made every read of a row the create DTO
 * stored fail; codegen refuses it, naming the column, and keeps the rewrites whose output parses
 * again. A NOT NULL column whose schema takes null gave a write DTO that took a body the insert
 * fails, the c.json sibling of r19 C5's plain json; one whose schema takes undefined, with no default
 * for drizzle to write, the same through .optional() (AA4 of area A's review). Postgres's round trip
 * is pg-json-stored-document.test.ts's, apart, as macOS's runners have no Postgres server.
 */
import { drizzle } from "drizzle-orm/libsql"
import { afterAll, describe, expect, it } from "vitest"
import type * as z from "zod"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"
import { DIALECTS, KEPT, type Kept, roundTrip, rowDdl, type Store, table } from "../support/json-stored-document.ts"
import { libsqlMemory } from "../support/libsql.ts"

afterAll(() => cleanGeneratedDtos())

/* schemas whose output is another value than their input takes, each refused */
const REFUSED: Array<[kind: string, schema: string]> = [
	["a transform", 'z.object({ tags: z.string().transform((text) => text.split(",")) })'],
	["a pipe", "z.object({ size: z.string().pipe(z.coerce.number()) })"],
	["a preprocess", "z.object({ name: z.preprocess((value) => String(value), z.string()) })"],
	[
		"a transform inside an array's union",
		"z.array(z.union([z.number(), z.string().transform((text) => text.length)]))",
	],
	["a transform behind z.lazy", "z.object({ inner: z.lazy(() => z.string().transform((text) => text.length)) })"],
]

/* insert into libsql's in-memory SQLite, and select it back */
const store: Store = async (tables, value) => {
	const { client, close } = libsqlMemory()
	try {
		await client.execute(rowDdl("sqlite"))
		const db = drizzle({ client })
		await db.insert(tables.row).values({ doc: value, id: "r1" } as never)
		return ((await db.select().from(tables.row)) as Array<{ doc: unknown }>)[0]?.doc
	} finally {
		close()
	}
}

describe("a c.json schema is the stored document (CD2, CD3; sibling: r19 C5's NOT NULL)", () => {
	it.each(KEPT)("keeps $kind on sqlite, whose stored row the read DTO takes", async (kept: Kept) => {
		const { read, stored } = await roundTrip(kept, "sqlite", store)
		expect(stored).toEqual(kept.stored)
		expect(read).toBe(true)
	})

	describe.each(DIALECTS)("on %s", (dialect) => {
		it.each(REFUSED)("refuses %s at codegen, naming the column", async (kind, schema) => {
			const name = `cd2-${dialect}-${REFUSED.findIndex(([each]) => each === kind)}`
			await expect(generatedDtos(name, table(dialect, schema), { dialect })).rejects.toThrow(
				"row.doc: a c.json schema is the stored document; its transform's output is what gets stored, and the read DTO could not parse it. Move the transform to the request body's schema.",
			)
		})

		it("refuses a NOT NULL column whose schema takes null, naming the column", async () => {
			await expect(
				generatedDtos(`cd3-${dialect}`, table(dialect, "z.object({ a: z.string() }).nullable()"), { dialect }),
			).rejects.toThrow(
				"row.doc: its schema takes null and the column is NOT NULL: make the column nullable, or pass the schema's non-null form",
			)
		})

		it("takes the same schema on a nullable column, and null in its write DTO (sibling)", async () => {
			const dtos = await generatedDtos(
				`cd3-nullable-${dialect}`,
				table(dialect, "z.object({ a: z.string() }).nullable()", 'c.json("doc", Doc)'),
				{ dialect },
			)
			const create = dtos["row"]?.["rowDtoCreateSchema"] as z.ZodType
			expect(create.safeParse({ doc: null, id: "r1" }).success).toBe(true)
		})
	})
})

/* AA4 of area A's review: CD3's class through .optional(), whose create DTO took {} and the insert failed */
describe.each(DIALECTS)("a NOT NULL c.json whose schema takes undefined (AA4) on %s", (dialect) => {
	it("refuses a NOT NULL column with no default whose schema takes undefined, naming the column", async () => {
		await expect(
			generatedDtos(`aa4-${dialect}`, table(dialect, "z.object({ a: z.string() }).optional()"), { dialect }),
		).rejects.toThrow(
			"row.doc: its schema takes undefined (an .optional(), a .default() or a union with undefined) and the column is NOT NULL with no default: make the schema refuse undefined, or give the column a default",
		)
	})

	it("takes it where the column has a default, which drizzle writes for a body that leaves it out (sibling)", async () => {
		const dtos = await generatedDtos(
			`aa4-default-${dialect}`,
			table(dialect, "z.object({ a: z.string() }).optional()", 'c.json("doc", Doc).notNull().default({ a: "x" })'),
			{ dialect },
		)
		expect(dtos["row"]?.["rowDtoCreateSchema"]).toBeDefined()
	})
})
