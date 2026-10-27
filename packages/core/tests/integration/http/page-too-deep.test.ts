/**
 * L2 of the 0.12 consumers review, end to end: a schema-built list answers a page past its maxPage
 * with the 400 `page_too_deep` a hand-built list answers, through a Hono app's own validator and
 * error handler, not a field error under `validation_failed`
 */
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { CombError } from "../../../src/error.ts"
import { createListQuerySchema } from "../../../src/query/index.ts"

/** An app as a consumer wires one: comb's schema in zValidator, and a CombError answered by its key */
function app(maxPage?: number) {
	const schema = createListQuerySchema({ sort: ["id"], ...(maxPage ? { pagination: { maxPage } } : {}) })
	return new Hono()
		.get("/items", zValidator("query", schema), (c) => c.json({ page: c.req.valid("query").page ?? 1 }))
		.onError((error, c) => {
			if (error instanceof CombError) return c.json({ error_key: error.errorKey }, error.status as 400)
			return c.json({ error_key: "internal" }, 500)
		})
}

const get = async (hono: Hono, query: string) => {
	const response = await hono.request(`/items?${query}`)
	return { body: await response.json(), status: response.status }
}

describe("a page past maxPage through a Hono app", () => {
	it("answers 400 page_too_deep past the default 10 000, and takes the page at it", async () => {
		const hono = app() as unknown as Hono
		expect(await get(hono, "page=10000")).toEqual({ body: { page: 10_000 }, status: 200 })
		expect(await get(hono, "page=10001")).toEqual({ body: { error_key: "page_too_deep" }, status: 400 })
	})

	it("answers a list's own maxPage the same way", async () => {
		const hono = app(50) as unknown as Hono
		expect(await get(hono, "page=50")).toEqual({ body: { page: 50 }, status: 200 })
		expect(await get(hono, "page=51")).toEqual({ body: { error_key: "page_too_deep" }, status: 400 })
	})

	/* U36: a malformed page is the 400 invalid_page buildListQuery and paginate answer, not a field error */
	it("answers a page that is no whole number from 1, in decimal digits, 400 invalid_page", async () => {
		const hono = app(50) as unknown as Hono
		for (const page of ["0", "1.5", "0x10", "1e3", "x"])
			expect(await get(hono, `page=${page}`)).toEqual({ body: { error_key: "invalid_page" }, status: 400 })
	})
})
