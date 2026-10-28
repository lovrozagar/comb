/**
 * Plan 14's 4.18: comb builds no code from strings. workerd refuses `new Function` ("Code generation
 * from strings disallowed"), so a compiled schema never compiled on Workers and only added zod's
 * compiler to the bundle. Under `jitless`, zod's own setting for a runtime without eval, which a
 * Worker gets from its user agent, every comb schema builds and parses with no Function made: the
 * query schemas, the pagination meta and a generated entity's DTOs. The consumer suite runs the same
 * on workerd itself.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as z from "zod"
import { cleanGeneratedDtos, generatedDtos } from "../support/dtos.ts"

const RealFunction = globalThis.Function
let made = 0

beforeAll(() => {
	z.config({ jitless: true })
	/* every way code is made from a string: `new Function(…)` and `Function(…)` */
	globalThis.Function = new Proxy(RealFunction, {
		apply: (target, self, args) => {
			made++
			return Reflect.apply(target, self, args)
		},
		construct: (target, args) => {
			made++
			return Reflect.construct(target, args)
		},
	})
})

afterAll(() => {
	globalThis.Function = RealFunction
	z.config({ jitless: false })
	cleanGeneratedDtos()
})

describe("comb's schemas under jitless (4.18)", () => {
	it("build and parse with no Function made from a string", async () => {
		const { createListQuerySchema, createRetrieveQuerySchema, paginationResponseSchema } =
			await import("../../../src/query/schema.ts")
		const list = createListQuerySchema({ filter: { status: "enum" }, sort: ["createdAt", "name"] as const })
		expect(list.safeParse({ filter: "status.eq.active", limit: "10", order: "name.desc" }).success).toBe(true)
		const retrieve = createRetrieveQuerySchema({ fields: { scalars: ["id", "name"] } })
		expect(retrieve.safeParse({ select: "id" }).success).toBe(true)
		expect(
			paginationResponseSchema.safeParse({ count: 1, hasMore: false, limit: 10, nextCursor: null, page: 1 }).success,
		).toBe(true)
		const dtos = await generatedDtos(
			"no-eval",
			`export const post = sqliteTable("post", { id: c.id("pst"), title: c.text("title", { max: 80 }).notNull() })`,
		)
		const post = dtos["post"]
		expect(post?.["postDtoCreateSchema"]?.safeParse({ title: "Hello" }).success).toBe(true)
		expect(post?.["postDtoReadSchema"]?.safeParse({ id: "pst_1", title: "Hello" }).success).toBe(true)
		expect(made).toBe(0)
	})
})
