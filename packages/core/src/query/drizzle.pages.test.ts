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
