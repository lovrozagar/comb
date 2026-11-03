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

	/* Q2 of r21: on Postgres the key's family decides, as SQLite's storage class does */
	it("a Postgres double precision or other type past 2^53 is exact, an integer or numeric read as a number is rounded", () => {
		for (const types of ["float,other,other", "other,float,other"])
			expect(roundedKey({ _combKeyTypes: types, a: 1e20, b: 2 ** 60 }, SORT, "derived"), types).toBeUndefined()
		expect(roundedKey({ _combKeyTypes: "float,fixed,other", a: 1e20, b: 2 ** 60 }, SORT, "derived")?.cause).toMatch(
			/^b 1152921504606846976 is past ±\(2\^53 − 1\), where the driver rounded it: a derived list/,
		)
	})
})
