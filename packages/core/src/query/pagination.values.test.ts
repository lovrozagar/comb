/**
 * Q4 of r18: paginate holds each extra a row carries to its kind, as well as to its presence, so an
 * extra rendered by hand as its own alias string is page_not_wired, never read as a count or an id.
 */
import { describe, expect, it } from "vitest"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { built } from "./__fixtures__/built.ts"
import { queryHelpers } from "./drizzle.ts"

/** An offset page of up to ten rows, by created_at descending */
const offset = () =>
	built(
		{ limit: 10, parsedSort: [{ direction: "desc" as const, field: "createdAt" }], validated: true as const },
		SEALED,
	)

/* r18 Q4: an extra rendered by hand as its own alias string reaches paginate as a value; each is held to its kind */
describe("queryHelpers.paginate — an extra's value, as well as its presence", () => {
	const notWired = expect.objectContaining({ errorKey: "page_not_wired", status: 500 })

	it.each([
		["_total as its alias", { _combId: 1, _total: "_total", id: 1 }],
		["_total negative", { _combId: 1, _total: -1, id: 1 }],
		["_total fractional", { _combId: 1, _total: 1.5, id: 1 }],
		["_total past 2^53", { _combId: 1, _total: 2 ** 53, id: 1 }],
		["_total a negative bigint", { _combId: 1, _total: -1n, id: 1 }],
		["_combId as its alias", { _combId: "_combId", _total: 1, id: 1 }],
		["_combAnchorGone as its alias", { _combAnchorGone: "_combAnchorGone", _combId: 1, _total: 1, id: 1 }],
		["_combAnchorGone 2", { _combAnchorGone: 2, _combId: 1, _total: 1, id: 1 }],
		/* Q2 of r19: a digit string is a count only in its canonical decimal form, within 2^53 − 1 */
		["_total a padded digit string", { _combId: 1, _total: "05", id: 1 }],
		["_total a signed digit string", { _combId: 1, _total: "-1", id: 1 }],
		["_total a digit string past 2^53", { _combId: 1, _total: "9007199254740992", id: 1 }],
		["_total an empty string", { _combId: 1, _total: "", id: 1 }],
		["_combAnchorGone the string 2", { _combAnchorGone: "2", _combId: 1, _total: 1, id: 1 }],
	])("refuses %s as page_not_wired, naming the README form", (_, row) => {
		expect(() => queryHelpers.paginate([row], offset())).toThrow(notWired)
		expect(() => queryHelpers.paginate([row], offset())).toThrow(
			expect.objectContaining({
				cause: expect.stringContaining("sql`${extra.sql} AS ${sql.identifier(extra.fieldAlias)}`"),
			}),
		)
	})

	it("takes a count a driver reads as a bigint, and a flag as a boolean or a bigint", () => {
		const [, pagination] = queryHelpers.paginate([{ _combId: 1, _total: 5n, id: 1 }], offset())
		expect(pagination.count).toBe(5)
		for (const flag of [false, 0n])
			expect(queryHelpers.paginate([{ _combAnchorGone: flag, _combId: 1, _total: 1, id: 1 }], offset())[0]).toEqual([
				{ id: 1 },
			])
		for (const flag of [true, 1n])
			expect(() => queryHelpers.paginate([{ _combAnchorGone: flag, _combId: 1, _total: 1, id: 1 }], offset())).toThrow(
				expect.objectContaining({ errorKey: "invalid_cursor" }),
			)
	})

	/* Q2 of r19: libsql's intMode "string" reads every INTEGER, the extras included, as a decimal string */
	it("takes a count and a flag a driver reads as a decimal string, the count as a number", () => {
		const [, pagination] = queryHelpers.paginate([{ _combId: "1", _total: "5", id: "1" }], offset())
		expect(pagination.count).toBe(5)
		expect(queryHelpers.paginate([{ _combId: "1", _total: "0", id: "1" }], offset())[1].count).toBe(0)
		expect(queryHelpers.paginate([{ _combAnchorGone: "0", _combId: "1", _total: "1", id: "1" }], offset())[0]).toEqual([
			{ id: "1" },
		])
		expect(() =>
			queryHelpers.paginate([{ _combAnchorGone: "1", _combId: "1", _total: "1", id: "1" }], offset()),
		).toThrow(expect.objectContaining({ errorKey: "invalid_cursor" }))
	})
})
