import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { built } from "./__fixtures__/built.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { paginationIn, refuseGoneAnchor, refuseOverRead, refuseUnwired } from "./page-refusals.ts"
import { createListQuerySchema } from "./schema.ts"
import { buildListQuery } from "./sqlite/build-list-query.ts"

const post = sqliteTable("post", { id: integer("id").primaryKey(), title: text("title") })
const schema = createListQuerySchema({ pagination: { defaultLimit: 2, maxLimit: 10 }, sort: ["title"] })
const single = buildListQuery({ ...SEALED, parsed: schema.parse({ limit: "2", order: "title.asc" }), table: post })
const merged = buildListQuery({ ...SEALED, merged: {}, parsed: schema.parse({ limit: "2" }), table: post })
const counted = built(schema.parse({ limit: "2" }), { ...SEALED, expects: ["_combId", "_total"] }).pagination
const unwired = expect.objectContaining({ errorKey: "page_not_wired", status: 500 })

describe("refuseUnwired", () => {
	it("passes rows that carry every extra their builder selected, each its kind", () => {
		expect(() => refuseUnwired([{ _combId: 1, _total: 1, id: 1, title: "a" }], counted)).not.toThrow()
	})

	it("refuses rows read without the extras, naming each one missing", () => {
		expect(() => refuseUnwired([{ _combId: 1, id: 1 }, { id: 2 }], counted)).toThrow(
			expect.objectContaining({
				cause: expect.stringMatching(/^the rows carry no _combId, _total: select the built query's extras/),
				errorKey: "page_not_wired",
			}),
		)
	})

	it("refuses an extra rendered by hand as its own alias", () => {
		expect(() => refuseUnwired([{ _combId: 1, _total: "_total", id: 1 }], counted)).toThrow(
			expect.objectContaining({ cause: expect.stringMatching(/^the rows carry _total "_total", no value/) }),
		)
	})
})

describe("refuseGoneAnchor", () => {
	it("refuses a page whose anchor row is gone, as a driver reads the flag", () => {
		for (const flag of [1, 1n, true])
			expect(() => refuseGoneAnchor([{ id: 1 }, { _combAnchorGone: flag, id: 2 }])).toThrow(
				expect.objectContaining({ errorKey: "invalid_cursor", status: 400 }),
			)
	})

	it("passes rows whose flag is unset or 0", () => {
		expect(() => refuseGoneAnchor([{ id: 1 }, { _combAnchorGone: 0, id: 2 }, { _combAnchorGone: null }])).not.toThrow()
	})
})

describe("paginationIn", () => {
	it("returns the built query's pagination to the call that pages it", () => {
		expect(paginationIn(single, false)).toBe(single.pagination)
		expect(paginationIn(merged, true)).toBe(merged.pagination)
	})

	it("refuses a parsed query in the built query's place", () => {
		expect(() => paginationIn(schema.parse({}) as never, false)).toThrow(
			expect.objectContaining({ cause: expect.stringMatching(/^paginate takes the built query/) }),
		)
		expect(() => paginationIn(undefined, false)).toThrow(unwired)
	})

	it("sends a merged list to paginateMerged, and a single database's to paginate", () => {
		expect(() => paginationIn(merged as never, false)).toThrow(
			expect.objectContaining({ cause: expect.stringMatching(/is paged by paginateMerged/) }),
		)
		expect(() => paginationIn(single as never, true)).toThrow(
			expect.objectContaining({ cause: expect.stringMatching(/^paginateMerged pages a list/) }),
		)
	})
})

describe("refuseOverRead", () => {
	it("passes up to the rows the built query reads, and refuses one more", () => {
		const { window } = single.pagination
		expect(() => refuseOverRead(window, single.pagination)).not.toThrow()
		expect(() => refuseOverRead(window + 1, single.pagination)).toThrow(
			expect.objectContaining({
				cause: `paginate got ${window + 1} rows where the built query reads at most ${window}: apply its limit and offset (applyListQuery does)`,
				errorKey: "page_not_wired",
			}),
		)
	})
})
