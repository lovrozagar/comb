import { describe, expect, it } from "vitest"
import { roundedKey } from "./rounded-key.ts"
import type { SortField } from "./types.ts"

const SORT: SortField[] = [
	{ direction: "asc", field: "a" },
	{ direction: "desc", field: "b" },
]

describe("roundedKey", () => {
	it("names the first sort key a driver read as an integer number past ±(2^53 − 1), and why the list cannot page it", () => {
		expect(roundedKey({ a: 1, b: -(2 ** 60) }, SORT, "derived")).toMatchObject({
			cause:
				"b -1152921504606846976 is past ±(2^53 − 1), where the driver rounded it: a derived list has no row to read the exact key back from, so its integer sort keys must be within ±(2^53 − 1), or be read as bigint",
			errorKey: "sort_not_wired",
			status: 500,
		})
		expect(roundedKey({ a: 2 ** 60, b: 2 ** 61 }, SORT, "merged")?.cause).toBe(
			"a 1152921504606846976 is past ±(2^53 − 1), where the driver rounded it: a merged list's integer sort keys must be within ±(2^53 − 1), or be read as bigint",
		)
	})

	it("passes keys read exactly: a bigint, a safe integer, a fraction, and any other value", () => {
		for (const a of [2n ** 60n, Number.MAX_SAFE_INTEGER, 1.5, "9007199254740993", null, Number.POSITIVE_INFINITY])
			expect(roundedKey({ a, b: 1 }, SORT, "derived"), String(a)).toBeUndefined()
	})

	/* Q1 of r20: SQLite's storage class, which the builder selects as _combKeyTypes, says which number is rounded */
	it("a REAL past 2^53 is exact, an INTEGER read as a double is rounded", () => {
		for (const a of [1e20, -(2 ** 60), 2 ** 53, 2 ** 53 + 2])
			expect(roundedKey({ _combKeyTypes: "real,integer,text", a, b: 1 }, SORT, "derived"), String(a)).toBeUndefined()
		expect(roundedKey({ _combKeyTypes: "real,integer,text", a: 1e20, b: 2 ** 60 }, SORT, "merged")?.cause).toBe(
			"b 1152921504606846976 is past ±(2^53 − 1), where the driver rounded it: a merged list's integer sort keys must be within ±(2^53 − 1), or be read as bigint",
		)
	})

	/* Q1 of r22: a class no double names (a domain's, read as other, among them) is refused past 2^53, as an integer is */
	const REFUSED = "a 1152921504606846976 is past ±(2^53 − 1), where the driver rounded it: a derived list"
	it.each([
		["sqlite real", "real", undefined],
		["postgres float", "float", undefined],
		["sqlite integer", "integer", REFUSED],
		["postgres fixed", "fixed", REFUSED],
		["postgres other", "other", REFUSED],
		["sqlite text", "text", REFUSED],
		["sqlite null", "null", REFUSED],
	])("under %s (class %s), a number past 2^53 is refused: %s", (_, cls, refusal) => {
		const cause = roundedKey({ _combKeyTypes: `${cls},real,text`, a: 2 ** 60, b: 1 }, SORT, "derived")?.cause
		expect(cause === undefined ? undefined : String(cause).slice(0, REFUSED.length)).toBe(refusal)
	})
})

/* QL1 of r22b: an anchored list judges only the keys its anchor row doesn't supply, and says so */
describe("roundedKey on the keys a list binds as read (QL1 of r22b; sibling: a derived list's every key)", () => {
	it("judges only the keys given, naming a key no column of the anchor table", () => {
		const row = { a: 2 ** 60, b: 2 ** 61 }
		expect(roundedKey(row, SORT, { unread: (field) => field === "b" })?.cause).toBe(
			"b 2305843009213693952 is past ±(2^53 − 1), where the driver rounded it: the key is no column of the anchor table, nor an expression over its columns alone, so no row reads the exact key back: sort by a column of the anchor table, keep it within ±(2^53 − 1), or read it as bigint",
		)
		expect(roundedKey(row, SORT, { unread: () => false })).toBeUndefined()
	})
})
