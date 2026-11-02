import { describe, expect, it } from "vitest"
import { malformed, typedKeys } from "./list-extras.ts"
import type { SortField } from "./types.ts"

const SORT: SortField[] = [
	{ direction: "asc", field: "k" },
	{ direction: "desc", field: "name" },
]

/* Q2 of r19, part 4: SQLite's storage class of each sort key, which the builder selects as _combKeyTypes */
describe("malformed: _combKeyTypes", () => {
	it("takes one storage class per sort key and the tiebreak's, comma-joined, as typeof() answers", () => {
		for (const types of ["integer,text,text", "null,blob,integer", "real,integer,real", "+inf,-inf,integer"])
			expect(malformed({ _combId: 1, _combKeyTypes: types }, SORT), types).toBeUndefined()
	})

	it("names one of the wrong length, of an unknown class, or rendered by hand as its alias", () => {
		for (const types of [
			"integer,text",
			"integer,text,text,text",
			"int,text,text",
			"inf,text,text",
			"_combKeyTypes",
			7,
		])
			expect(malformed({ _combId: 1, _combKeyTypes: types }, SORT)).toBe(`_combKeyTypes ${JSON.stringify(types)}`)
	})
})

describe("typedKeys", () => {
	it("reads a sort key SQLite stored as an integer, which the driver read as a decimal string, as that integer", () => {
		expect(typedKeys({ _combKeyTypes: "integer,text,text", k: "12", name: "42" }, SORT)).toEqual({
			_combKeyTypes: "integer,text,text",
			k: 12n,
			name: "42",
		})
		expect(typedKeys({ _combKeyTypes: "integer,integer,text", k: "-9007199254740993", name: 3 }, SORT)).toEqual({
			_combKeyTypes: "integer,integer,text",
			k: -9007199254740993n,
			name: 3,
		})
	})

	it("leaves a row with no types, a text that looks like a number, and a key that is no canonical integer as they are", () => {
		const untyped = { k: "12", name: "a" }
		expect(typedKeys(untyped, SORT)).toBe(untyped)
		const text = { _combId: "7", _combKeyTypes: "text,text,text", k: "12", name: "a" }
		expect(typedKeys(text, SORT)).toBe(text)
		const odd = { _combKeyTypes: "integer,text,text", k: "012", name: "a" }
		expect(typedKeys(odd, SORT)).toBe(odd)
	})

	/* Q2 of r20: the merge compares the tiebreak as SQLite stored it too */
	it("reads the tiebreak SQLite stored as an integer, which the driver read as a decimal string, as that integer", () => {
		expect(typedKeys({ _combId: "12", _combKeyTypes: "text,text,integer", k: "a", name: "b" }, SORT)).toEqual({
			_combId: 12n,
			_combKeyTypes: "text,text,integer",
			k: "a",
			name: "b",
		})
	})

	/* Q3 of r20: D1's JSON transport reads a REAL ±Infinity as null */
	it("reads a key SQLite stored as a REAL ±Infinity, which the driver read as null, as that infinity", () => {
		expect(typedKeys({ _combKeyTypes: "+inf,-inf,integer", k: null, name: null }, SORT)).toEqual({
			_combKeyTypes: "+inf,-inf,integer",
			k: Number.POSITIVE_INFINITY,
			name: Number.NEGATIVE_INFINITY,
		})
		const exact = { _combKeyTypes: "+inf,real,integer", k: Number.POSITIVE_INFINITY, name: 1.5 }
		expect(typedKeys(exact, SORT)).toBe(exact)
	})
})
