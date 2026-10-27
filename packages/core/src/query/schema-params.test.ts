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
	selectQueryField,
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

describe("pickExtended", () => {
	it("takes the extension keys from the data, and nothing without extensions", () => {
		expect(pickExtended({ include: z.string() }, { include: "a", other: 1 })).toEqual({ include: "a" })
		expect(pickExtended(undefined, { other: 1 })).toEqual({})
	})
})

describe("the shared params and outputs", () => {
	it("bound select at 500 characters and lang at 2 to 10", () => {
		expect(selectQueryField.safeParse("x".repeat(501)).success).toBe(false)
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
