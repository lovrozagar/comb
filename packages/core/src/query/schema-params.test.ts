import { describe, expect, it } from "vitest"
import * as z from "zod"
import { FILTER_OPERATORS } from "./filter-parse.ts"
import {
	baseListQueryShape,
	filterAstSchema,
	langQueryField,
	limitSchemaFor,
	pageSchemaFor,
	parsedFieldsSchema,
	pickExtended,
	selectQueryFieldFor,
	sortDirectionEnum,
} from "./schema-params.ts"

/** Whether the filter AST schema takes a condition with this operator */
const withOperator = (operator: string) =>
	filterAstSchema.safeParse({ root: { conditions: [{ field: "a", operator, value: 1 }], logic: "and", subgroups: [] } })
		.success

describe("limitSchemaFor", () => {
	it("shares one schema for the default pagination and builds one for any other", () => {
		expect(limitSchemaFor(undefined)).toBe(limitSchemaFor({ defaultLimit: 20, maxLimit: 100 }))
		expect(limitSchemaFor({ maxLimit: 50 })).not.toBe(limitSchemaFor(undefined))
	})

	it("coerces, defaults and bounds the limit", () => {
		const limit = limitSchemaFor({ defaultLimit: 5, maxLimit: 10 })
		expect(limit.parse(undefined)).toBe(5)
		expect(limit.parse("7")).toBe(7)
		expect(limit.safeParse("11").success).toBe(false)
		expect(limit.safeParse("0").success).toBe(false)
		expect(limitSchemaFor(undefined).parse(undefined)).toBe(20)
	})
})

/*
 * AB4-9 of area B: a count held at most the digits its maximum needs, so the query string comb accepts
 * stays within maxQueryBytes; leading zeros past them held no number, and a 40 KB query parsed to limit 5
 */
describe("a limit or page of more digits than its maximum", () => {
	it("takes a limit at the cap's digits, leading zeros included, and refuses one digit more as an issue on limit", () => {
		const limit = limitSchemaFor(undefined)
		expect(limit.parse("100")).toBe(100)
		expect(limit.parse("005")).toBe(5)
		for (const raw of ["0005", "0100", `${"0".repeat(20_000)}5`]) {
			const parsed = z.object({ limit }).safeParse({ limit: raw })
			expect(parsed.success, raw.slice(0, 8)).toBe(false)
			expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["limit"]])
		}
	})

	it("takes a page at maxPage's digits, refuses padding one digit past them as invalid_page, and keeps a deeper page for maxPage's page_too_deep", () => {
		const page = pageSchemaFor(undefined)
		expect(page.parse("00005")).toBe(5)
		expect(page.parse("10000")).toBe(10_000)
		for (const raw of ["000005", `${"0".repeat(20_000)}2`])
			expect(() => page.parse(raw), raw.slice(0, 8)).toThrow(expect.objectContaining({ errorKey: "invalid_page" }))
		expect(page.parse("100000")).toBe(100_000)
	})
})

describe("pickExtended", () => {
	it("takes the extension keys from the data, and nothing without extensions", () => {
		expect(pickExtended({ include: z.string() }, { include: "a", other: 1 })).toEqual({ include: "a" })
		expect(pickExtended(undefined, { other: 1 })).toEqual({})
	})
})

describe("the shared params and outputs", () => {
	it("bound select at 500 characters and lang at 2 to 10", () => {
		expect(selectQueryFieldFor({ scalars: ["x"] }).safeParse("x".repeat(501)).success).toBe(false)
		expect(langQueryField.safeParse("e").success).toBe(false)
		expect(langQueryField.parse("en")).toBe("en")
	})

	it("coerce page to an integer from 1 to maxPage and take a cursor string", () => {
		const shape = z.object({ ...baseListQueryShape, page: pageSchemaFor(undefined) })
		expect(shape.parse({ cursor: "c", page: "2" })).toEqual({ cursor: "c", page: 2 })
		expect(() => shape.safeParse({ page: "0" })).toThrow(expect.objectContaining({ errorKey: "invalid_page" }))
		expect(pageSchemaFor({ maxPage: 10_000 })).toBe(pageSchemaFor(undefined))
	})

	it("describe the parsed selection, filter AST and sort direction", () => {
		const fields = { root: { relations: { author: { relations: {}, scalars: ["name"] } }, scalars: ["id"] } }
		expect(parsedFieldsSchema.parse(fields)).toEqual(fields)
		const ast = {
			root: {
				conditions: [{ field: "a", operator: "eq", value: 1 }],
				logic: "and",
				subgroups: [{ conditions: [], logic: "or", subgroups: [] }],
			},
		}
		expect(filterAstSchema.parse(ast)).toEqual(ast)
		/* the schema is the FilterAST type, every parsed operator included, so a generator that reads it agrees */
		expect(FILTER_OPERATORS.map(withOperator)).toEqual(FILTER_OPERATORS.map(() => true))
		expect(withOperator("between")).toBe(false)
		expect(sortDirectionEnum.options).toEqual(["asc", "desc"])
	})
})
