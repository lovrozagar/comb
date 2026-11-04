import { integer, sqliteTable } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"
import { createCursor } from "./cursor-mint.ts"
import { queryHelpers } from "./drizzle.ts"
import { buildDerivedListQuery, buildListQuery } from "./sqlite/build-list-query.ts"
import type { ListQueryInput } from "./types.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"

/* U5 of the 0.12 round: listOptions bounds a page no schema validated as buildListQuery does */
describe("queryHelpers.listOptions on a page no schema validated", () => {
	it.each([
		[50_000, "page_too_deep"],
		[0, "invalid_page"],
		[1.5, "invalid_page"],
	])("refuses page %s with %s", (page, errorKey) => {
		expect(() => queryHelpers.listOptions({ limit: 20, page, parsedSort: [] }, SEALED)).toThrow(
			expect.objectContaining({ errorKey, status: 400 }),
		)
	})

	it("takes a whole page within the cap", () => {
		expect(queryHelpers.listOptions({ limit: 20, page: 3, parsedSort: [] }, SEALED).offset).toBe(40)
	})
})

/* Q16 of r17: a limit reaches LIMIT and OFFSET as a page does, so one no schema validated is bounded too */
describe("every list builder on a limit no schema validated", () => {
	const t = sqliteTable("t", { id: integer("id").primaryKey() })
	const cursor = createCursor({ id: 1 }, [], SEALED)
	const builders = {
		buildDerivedListQuery: (parsed: ListQueryInput) =>
			buildDerivedListQuery({ ...SEALED, idColumn: t.id, parsed, sortColumns: {} }),
		buildListQuery: (parsed: ListQueryInput) => buildListQuery({ ...SEALED, parsed, table: t }),
		listOptions: (parsed: ListQueryInput) => queryHelpers.listOptions(parsed, SEALED),
		merged: (parsed: ListQueryInput) => buildListQuery({ ...SEALED, merged: {}, parsed, table: t }),
	}
	it.each(
		Object.keys(builders).flatMap((name) =>
			[2.5, 0, -1, Number.NaN].flatMap((limit) => [
				[name, limit, undefined],
				[name, limit, cursor],
			]),
		),
	)("%s refuses limit %s, cursor %s, as a 400 naming it", (name, limit, given) => {
		const builder = builders[name as keyof typeof builders]
		expect(() => builder({ cursor: given as string | undefined, limit: limit as number, parsedSort: [] })).toThrow(
			expect.objectContaining({
				cause: `limit ${String(limit)} is not a whole number from 1`,
				errorKey: "invalid_page",
				status: 400,
			}),
		)
	})
})

/* QL11 of r22b: listOptions answered a sort wiring mistake with cursor_pagination_unsupported, on a page with no cursor */
/** A validated page-1 query sorted by `field` */
const parsedBy = (field: string): ListQueryInput => ({
	limit: 20,
	parsedSort: [{ direction: "asc", field }],
	validated: true,
})

describe("listOptions on a sort it cannot run (QL11 of r22b; sibling: buildListQuery's sort_not_wired)", () => {
	const t = sqliteTable("t", { id: integer("id").primaryKey(), n: integer("n") })

	it("refuses a computed sort where the options are built, as sort_not_wired", () => {
		expect(() => queryHelpers.listOptions(parsedBy("@pop"), SEALED)).toThrow(
			expect.objectContaining({
				cause: "Sort on '@pop' is computed, which the relational listOptions cannot order by: use buildListQuery",
				errorKey: "sort_not_wired",
				status: 500,
			}),
		)
	})

	it("refuses a sort on no column of the queried table as sort_not_wired, as buildListQuery does", () => {
		const options = queryHelpers.listOptions(parsedBy("nope"), SEALED)
		const notWired = expect.objectContaining({
			cause: "Sort on 'nope' has no column to run it",
			errorKey: "sort_not_wired",
			status: 500,
		})
		expect(() => options.orderBy(t as never)).toThrow(notWired)
		expect(() => buildListQuery({ ...SEALED, parsed: parsedBy("nope"), table: t })).toThrow(notWired)
		expect(() => queryHelpers.listOptions(parsedBy("n"), SEALED).orderBy(t as never)).not.toThrow()
	})
})
