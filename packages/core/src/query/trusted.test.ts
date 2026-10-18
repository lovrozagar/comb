import { describe, expect, it } from "vitest"
import { assertSchemaParsed } from "./trusted.ts"

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
