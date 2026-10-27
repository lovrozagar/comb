import { describe, expect, it } from "vitest"
import { assertPageWithin, assertSchemaParsed } from "./trusted.ts"

const ast = {
	root: {
		conditions: [{ field: "password_hash", operator: "like" as const, value: "a*" }],
		logic: "and" as const,
		subgroups: [],
	},
}

describe("assertSchemaParsed (S-M8)", () => {
	it("refuses a filter that did not come through the list schema, which would query any column", () => {
		expect(() => assertSchemaParsed({ filterAst: ast, parsedSort: [] })).toThrow(
			expect.objectContaining({ errorKey: "filter_not_wired", status: 500 }),
		)
	})

	it("refuses an order that did not come through the list schema", () => {
		expect(() =>
			assertSchemaParsed({ filterAst: null, parsedSort: [{ direction: "asc", field: "password_hash" }] }),
		).toThrow(expect.objectContaining({ errorKey: "sort_not_wired", status: 500 }))
	})

	it("passes the schema's output, and a request with neither a filter nor an order", () => {
		expect(() =>
			assertSchemaParsed({ filterAst: ast, parsedSort: [{ direction: "asc", field: "id" }], validated: true }),
		).not.toThrow()
		expect(() => assertSchemaParsed({ filterAst: null, parsedSort: [] })).not.toThrow()
	})
})

describe("assertPageWithin: a page no schema bounded (C4)", () => {
	it("refuses a hand-built page past the default maxPage with a 400, and trusts the schema's own bound", () => {
		expect(() => assertPageWithin({ page: 10_000 })).not.toThrow()
		expect(() => assertPageWithin({ page: 10_001 })).toThrow(
			expect.objectContaining({ errorKey: "page_too_deep", status: 400 }),
		)
		/* a schema configured with a deeper maxPage checked the page already, and brands it so (U29) */
		expect(() => assertPageWithin({ page: 50_000, pageBounded: true })).not.toThrow()
		expect(() => assertPageWithin({})).not.toThrow()
	})
})

/* U5 of the 0.12 round: a page no schema validated is a whole number from 1, in both builders */
/* U29: validated: true says the filter and order were checked, never that the page was */
describe("assertPageWithin: a page on a filter its caller checked itself", () => {
	it.each([0, -1, 1.5, Number.NaN])("refuses page %s with invalid_page, validated or not", (page) => {
		expect(() => assertPageWithin({ page, validated: true })).toThrow(
			expect.objectContaining({ errorKey: "invalid_page" }),
		)
		expect(() => assertPageWithin({ page, pageBounded: true })).toThrow(
			expect.objectContaining({ errorKey: "invalid_page" }),
		)
	})

	it("refuses a page past the default maxPage when only the filter was checked", () => {
		expect(() => assertPageWithin({ page: 10_001, validated: true })).toThrow(
			expect.objectContaining({ errorKey: "page_too_deep" }),
		)
	})
})

describe("assertPageWithin: a page that is no page", () => {
	it.each([0, -1, 1.5, Number.NaN])("refuses page %s with invalid_page", (page) => {
		expect(() => assertPageWithin({ page })).toThrow(
			expect.objectContaining({
				cause: `page ${page} is not a whole number from 1`,
				errorKey: "invalid_page",
				status: 400,
			}),
		)
	})
})
