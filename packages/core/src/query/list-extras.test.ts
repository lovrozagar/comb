import { describe, expect, it } from "vitest"
import { carriedTexts, malformed, typedKeys } from "./list-extras.ts"
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

	/* Q2 of r21: a Postgres list's keys carry their family, which typedKeys reads no value by */
	it("takes Postgres's families, and leaves a key of one as the driver read it", () => {
		expect(malformed({ _combId: 1, _combKeyTypes: "float,fixed,other" }, SORT)).toBeUndefined()
		const row = { _combKeyTypes: "fixed,other,other", k: "12", name: "42" }
		expect(typedKeys(row, SORT)).toBe(row)
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
	/* B2-4 of area B: drizzle's SQLite numeric() reads a REAL as the text of its double */
	it("reads a sort key SQLite stored as a REAL, which the mapper read as its double's text, as that double, and no other text", () => {
		expect(typedKeys({ _combKeyTypes: "real,real,text", k: "0.1", name: "1e21" }, SORT)).toEqual({
			_combKeyTypes: "real,real,text",
			k: 0.1,
			name: "1e21",
		})
	})

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

/* QL2 of r22b: a time key's stored value, carried where the Date the driver read keeps milliseconds only */
describe("typedKeys and malformed: _combKeyTexts (QL2 of r22b; sibling: _combKeyTypes)", () => {
	const at = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 123))

	it("puts a Postgres time key's text, and a SQLite REAL's seconds, in place of the Date", () => {
		const pg = { _combKeyTexts: "2024-01-01 00:00:00.1231,", _combKeyTypes: "time,other,other", k: at, name: "a" }
		expect(typedKeys(pg, SORT)).toMatchObject({ k: "2024-01-01 00:00:00.1231", name: "a" })
		const lite = { _combKeyTexts: "100.00010000000000,", _combKeyTypes: "real,text,text", k: at, name: "a" }
		expect(typedKeys(lite, SORT)).toMatchObject({ k: 100.0001, name: "a" })
	})

	it("leaves a key with nothing carried, a value that is no Date, and a row with no times as they are", () => {
		const none = { _combKeyTexts: ",", _combKeyTypes: "time,other,other", k: at, name: "a" }
		expect(typedKeys(none, SORT)).toBe(none)
		const text = { _combKeyTexts: "x,y", _combKeyTypes: "time,other,other", k: "x", name: "y" }
		expect(typedKeys(text, SORT)).toBe(text)
		const untimed = { _combKeyTypes: "time,other,other", k: at, name: "a" }
		expect(typedKeys(untimed, SORT)).toBe(untimed)
	})

	it("takes one stored time per sort key, and names one of the wrong length or rendered by hand as its alias", () => {
		expect(malformed({ _combId: 1, _combKeyTexts: "a," }, SORT)).toBeUndefined()
		expect(malformed({ _combId: 1, _combKeyTypes: "time,fixed,other" }, SORT)).toBeUndefined()
		for (const times of ["a", "a,b,c", 7])
			expect(malformed({ _combId: 1, _combKeyTexts: times }, SORT)).toBe(`_combKeyTexts ${JSON.stringify(times)}`)
	})
})

/* QL3 of r22b: a carried text stands in for the number the driver rounded, with or without classes */
describe("typedKeys with a carried text (QL3 of r22b; sibling: a time key's stored value)", () => {
	it("takes a carried text for a number, keeps any other value and an empty carriage, with no classes selected", () => {
		const row = { _combId: 1, _combKeyTexts: "0.1000000000000000001,", k: 0.1, name: 0.5 }
		expect(typedKeys(row, SORT)).toEqual({ ...row, k: "0.1000000000000000001" })
		const text = { _combId: 1, _combKeyTexts: "0.25,", k: "0.25", name: "x" }
		expect(typedKeys(text, SORT)).toBe(text)
	})

	it("takes it under the classes too", () => {
		const row = {
			_combId: 1,
			_combKeyTexts: "0.1000000000000000001,",
			_combKeyTypes: "fixed,other,other",
			k: 0.1,
			name: "x",
		}
		expect(typedKeys(row, SORT)["k"]).toBe("0.1000000000000000001")
	})
})

/* comb-9d's AB2 ruling: the cursor flags each key whose value is a carried text, which binds as itself */
describe("carriedTexts (comb-9d's AB2 ruling; sibling: typedKeys' carried text)", () => {
	it("names a key whose value typedKeys took from the carried text, and no key read as its text already", () => {
		expect(carriedTexts({ _combId: 1, _combKeyTexts: "0.1000000000000000001,", k: 0.1, name: 0.5 }, SORT)).toEqual(
			new Set(["k"]),
		)
		expect(carriedTexts({ _combId: 1, _combKeyTexts: "0.25,", k: "0.25", name: "12" }, SORT)).toEqual(new Set())
	})

	it("names none on a row that carries no texts", () => {
		expect(carriedTexts({ _combId: 1, k: "12", name: "x" }, SORT)).toEqual(new Set())
	})
})
