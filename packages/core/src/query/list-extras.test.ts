import { describe, expect, it } from "vitest"
import { malformed, typedKeys } from "./list-extras.ts"
import type { SortField } from "./types.ts"

const SORT: SortField[] = [
	{ direction: "asc", field: "k" },
	{ direction: "desc", field: "name" },
]

/* Q2 of r19, part 4: SQLite's storage class of each sort key, which the builder selects as _combKeyTypes */
describe("malformed: _combKeyTypes", () => {
	it("takes one storage class per sort key, comma-joined, as typeof() answers", () => {
		for (const types of ["integer,text", "null,blob", "real,integer"])
			expect(malformed({ _combId: 1, _combKeyTypes: types }, SORT), types).toBeUndefined()
	})

	it("names one of the wrong length, of an unknown class, or rendered by hand as its alias", () => {
		for (const types of ["integer", "integer,text,text", "int,text", "_combKeyTypes", 7])
			expect(malformed({ _combId: 1, _combKeyTypes: types }, SORT)).toBe(`_combKeyTypes ${JSON.stringify(types)}`)
	})
})

describe("typedKeys", () => {
	it("reads a sort key SQLite stored as an integer, which the driver read as a decimal string, as that integer", () => {
		expect(typedKeys({ _combKeyTypes: "integer,text", k: "12", name: "42" }, SORT)).toEqual({
			_combKeyTypes: "integer,text",
			k: 12n,
			name: "42",
		})
		expect(typedKeys({ _combKeyTypes: "integer,integer", k: "-9007199254740993", name: 3 }, SORT)).toEqual({
			_combKeyTypes: "integer,integer",
			k: -9007199254740993n,
			name: 3,
		})
	})

	it("leaves a row with no types, a text that looks like a number, and a key that is no canonical integer as they are", () => {
		const untyped = { k: "12", name: "a" }
		expect(typedKeys(untyped, SORT)).toBe(untyped)
		const text = { _combKeyTypes: "text,text", k: "12", name: "a" }
		expect(typedKeys(text, SORT)).toBe(text)
		const odd = { _combKeyTypes: "integer,text", k: "012", name: "a" }
		expect(typedKeys(odd, SORT)).toBe(odd)
	})
})
