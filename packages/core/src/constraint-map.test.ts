import { describe, expect, it } from "vitest"
import { findNamed, lookup, own, shown, shownColumn, toCombError } from "./constraint-map.ts"
import type { ConstraintMap } from "./types.ts"

const MAPS: ConstraintMap[] = [
	{ a: { unique: { email: { cause: "first", errorKey: "a_email_first" } } } },
	{
		a: { unique: { email: { cause: "second", errorKey: "a_email_second" } } },
		b: { check: { b_n_check: { cause: "n", errorKey: "b_n_invalid", statusKey: "forbidden" } } },
	},
]

const FALLBACK = { cause: "generic", errorKey: "generic_key", status: "conflict" } as const

describe("own", () => {
	it("reads own keys only", () => {
		expect(own({ a: 1 }, "a")).toBe(1)
		expect(own({ a: 1 }, "toString")).toBeUndefined()
		expect(own({ a: 1 }, undefined)).toBeUndefined()
		expect(own(undefined, "a")).toBeUndefined()
	})
})

describe("lookup", () => {
	it("returns the first map's entry for the table", () => {
		expect(lookup(MAPS, "a", (t) => own(t.unique, "email"))?.errorKey).toBe("a_email_first")
		expect(lookup(MAPS, "b", (t) => own(t.unique, "email"))).toBeUndefined()
		expect(lookup(MAPS, "constructor", (t) => own(t.unique, "email"))).toBeUndefined()
		expect(lookup(MAPS, undefined, (t) => own(t.unique, "email"))).toBeUndefined()
	})
})

describe("findNamed", () => {
	it("finds a CHECK by name in any table", () => {
		expect(findNamed(MAPS, "check", "b_n_check")).toMatchObject({ entry: { errorKey: "b_n_invalid" }, table: "b" })
		expect(findNamed(MAPS, "check", "nope")).toBeUndefined()
		expect(findNamed(MAPS, "unique", undefined)).toBeUndefined()
	})
})

describe("toCombError", () => {
	it("uses the entry, its status, and keeps the source", () => {
		const source = new Error("raw")
		const entry = own(MAPS[1]?.b?.check, "b_n_check")
		const error = toCombError({ column: "n", entry, fallback: FALLBACK, table: "b" }, source)
		expect(error).toMatchObject({ cause: "n", column: "n", errorKey: "b_n_invalid", status: 403, table: "b" })
		expect(error.source).toBe(source)
	})

	it("defaults an entry's status to the kind's: bad_request stays, everything else is conflict", () => {
		const entry = { cause: "c", errorKey: "k" }
		expect(toCombError({ entry, fallback: FALLBACK }, null).status).toBe(409)
		expect(toCombError({ entry, fallback: { ...FALLBACK, status: "bad_request" } }, null).status).toBe(400)
	})

	it("falls back to the generic error without an entry", () => {
		expect(toCombError({ entry: undefined, fallback: FALLBACK, table: "a" }, null)).toMatchObject({
			cause: "generic",
			errorKey: "generic_key",
			status: 409,
			table: "a",
		})
	})
})

/* F67: the columns an error may name, by the private columns any map lists for the table */
describe("shown and shownColumn", () => {
	const maps: ConstraintMap[] = [{ a: {} }, { a: { private: ["pin"] } }]

	it("names every column, or none once any map lists one as the table's private column", () => {
		expect(shown(maps, "a", ["owner", "slug"])).toEqual(["owner", "slug"])
		expect(shown(maps, "a", ["owner", "pin"])).toEqual([])
		expect(shown(maps, "b", ["pin"])).toEqual(["pin"])
		expect(shown(maps, undefined, ["pin"])).toEqual(["pin"])
	})

	it("names one column unless it is private, and nothing for no column", () => {
		expect(shownColumn(maps, "a", "owner")).toBe("owner")
		expect(shownColumn(maps, "a", "pin")).toBeUndefined()
		expect(shownColumn(maps, "a", undefined)).toBeUndefined()
	})
})
