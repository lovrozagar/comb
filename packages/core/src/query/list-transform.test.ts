import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createCursor } from "./cursor.ts"
import { FILTER_LIMITS } from "./filter.ts"
import { checkCursor, filterAstOf, parsedSortOf, reportOutputIssues, sortOrderByOf } from "./list-transform.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"

type Issue = { message: string; path: PropertyKey[] }

function recorder() {
	const issues: Issue[] = []
	const ctx = { addIssue: (issue: Issue) => issues.push({ message: issue.message, path: issue.path }) }
	return { ctx: ctx as unknown as z.RefinementCtx, issues }
}

describe("filterAstOf", () => {
	const param = { fields: { n: "number" as const }, limits: FILTER_LIMITS }

	it("is null with no issue for no filter, or only whitespace", () => {
		const { ctx, issues } = recorder()
		expect(filterAstOf(undefined, param, ctx)).toBeNull()
		expect(filterAstOf("  ", param, ctx)).toBeNull()
		expect(issues).toEqual([])
	})

	it("returns the typed AST of a valid filter, and an issue on filter for a refused one", () => {
		const { ctx, issues } = recorder()
		expect(filterAstOf("n.eq.1", param, ctx)?.root.conditions).toEqual([{ field: "n", operator: "eq", value: 1 }])
		expect(filterAstOf("n.eq.x,m.eq.1", param, ctx)).toBeNull()
		expect(issues).toEqual([
			{ message: "Invalid value for 'n': expects a number, got 'x'; Unknown filter field: m", path: ["filter"] },
		])
	})
})

describe("parsedSortOf", () => {
	const param = { maxSortKeys: 2, sort: ["created_at", "title"] as const }

	it("keeps declared fields with their direction and null placement", () => {
		const { ctx, issues } = recorder()
		expect(parsedSortOf("title.asc.nullsfirst,created_at.desc", param, ctx)).toEqual([
			{ direction: "asc", field: "title", nulls: "first" },
			{ direction: "desc", field: "created_at" },
		])
		expect(issues).toEqual([])
	})

	it("falls back to the first declared field descending, or nothing when none is declared", () => {
		const { ctx } = recorder()
		expect(parsedSortOf(undefined, param, ctx)).toEqual([{ direction: "desc", field: "created_at" }])
		expect(parsedSortOf(undefined, { maxSortKeys: 2, sort: [] }, ctx)).toEqual([])
	})

	it("reports too many keys and unknown fields on order", () => {
		const { ctx, issues } = recorder()
		parsedSortOf("nope,title,created_at", param, ctx)
		expect(issues).toEqual([
			{ message: "Too many sort keys: 3 (max 2)", path: ["order"] },
			{ message: "Unknown sort field: nope", path: ["order"] },
		])
	})
})

describe("checkCursor", () => {
	const sort = [{ direction: "desc" as const, field: "created_at" }]

	it("accepts no cursor and a sealed one, whatever sort it holds, and reports one of no sealed shape", () => {
		const { ctx, issues } = recorder()
		checkCursor(undefined, ctx)
		checkCursor(createCursor({ created_at: 1, id: 1 }, sort, SEALED), ctx)
		checkCursor(createCursor({ id: 1, title: "a" }, [{ direction: "asc", field: "title" }], SEALED), ctx)
		checkCursor("eyJ4IjoxfQ", ctx)
		expect(issues).toEqual([{ message: "Invalid cursor", path: ["cursor"] }])
	})
})

describe("sortOrderByOf", () => {
	it("maps each sort field to its direction", () => {
		expect(
			sortOrderByOf([
				{ direction: "desc", field: "created_at" },
				{ direction: "asc", field: "title" },
			]),
		).toEqual({ created_at: "desc", title: "asc" })
	})
})

describe("reportOutputIssues", () => {
	it("reports each issue the output schema finds at its own path, and nothing for a valid output", () => {
		const { ctx, issues } = recorder()
		const schema = z.object({ limit: z.number() })
		reportOutputIssues(schema, { limit: 1 }, ctx)
		reportOutputIssues(schema, { limit: "x" }, ctx)
		expect(issues).toEqual([{ message: expect.stringContaining("number") as unknown as string, path: ["limit"] }])
	})
})
