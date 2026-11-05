import { describe, expect, it, vi } from "vitest"
import {
	checkedOnce,
	defineConstraintMaps,
	entryOf,
	findNamed,
	lookup,
	own,
	shown,
	shownColumn,
	type TableMap,
	toCombError,
} from "./constraint-map.ts"
import type { ConstraintMap } from "./types.ts"

const MAPS: ConstraintMap[] = [
	{ a: { unique: { email: { cause: "first", errorKey: "a_email_first" } } } },
	{
		a: { unique: { email: { cause: "second", errorKey: "a_email_second" } } },
		b: { check: { b_n_check: { cause: "n", errorKey: "b_n_invalid", statusKey: "forbidden" } } },
	},
]

const FALLBACK = { cause: "generic", errorKey: "constraint_violation", status: "conflict" } as const

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
			errorKey: "constraint_violation",
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
		expect(shown(maps, undefined, ["pin"])).toEqual(["pin"])
	})

	/* Q9 of r17 and Q10 of r18: maps that key no such table cannot say which of its columns are private */
	it("names no column of a table the maps given key nowhere, and every column when no map is given", () => {
		expect(shown(maps, "b", ["pin"])).toEqual([])
		expect(shownColumn(maps, "b", "owner")).toBeUndefined()
		expect(shown([], "b", ["pin"])).toEqual(["pin"])
	})

	it("names one column unless it is private, and nothing for no column", () => {
		expect(shownColumn(maps, "a", "owner")).toBe("owner")
		expect(shownColumn(maps, "a", "pin")).toBeUndefined()
		expect(shownColumn(maps, "a", undefined)).toBeUndefined()
	})
})

/* R5 of plan 17: a key ending in `*` is a prefix pattern, for runtime tables no generated map can name */
describe("entryOf", () => {
	const ut: TableMap = { private: ["secret"] }
	const longer: TableMap = {}
	const maps: ConstraintMap = { "ut_*": ut, "ut_x*": longer, users: {} }

	it("takes the table's own key first, then the longest prefix pattern it starts with", () => {
		expect(entryOf(maps, "users")).toBe(maps.users)
		expect(entryOf(maps, "ut_abc")).toBe(ut)
		expect(entryOf(maps, "ut_xyz")).toBe(longer)
		expect(entryOf(maps, "other")).toBeUndefined()
		expect(entryOf(maps, undefined)).toBeUndefined()
	})

	/* Q4 of r19: a malformed key never throws in place of the database error; defineConstraintMaps refuses it at load */
	it("skips a key with a `*` anywhere but its end, whatever table is asked for", () => {
		const bad: ConstraintMap = { "u*t": {}, users: {} }
		expect(entryOf(bad, "users")).toBe(bad.users)
		expect(entryOf(bad, "ut")).toBeUndefined()
		expect(entryOf(bad, "uxt")).toBeUndefined()
	})

	it("finds a pattern's named constraint through the violated table, never as a table of its own", () => {
		const named: ConstraintMap[] = [{ "ut_*": { check: { ut_n_check: { cause: "n", errorKey: "ut_n_invalid" } } } }]
		expect(findNamed(named, "check", "ut_n_check")).toBeUndefined()
		expect(lookup(named, "ut_abc", (t) => own(t.check, "ut_n_check"))).toMatchObject({ errorKey: "ut_n_invalid" })
	})

	it("makes a pattern's tables known, its private columns hidden and the rest named", () => {
		const patterned: ConstraintMap[] = [{ "ut_*": { private: ["secret"] }, users: {} }]
		expect(shown(patterned, "ut_abc", ["title"])).toEqual(["title"])
		expect(shown(patterned, "ut_abc", ["secret"])).toEqual([])
		expect(shown([{ users: {} }], "ut_abc", ["title"])).toEqual([])
	})
})

/* Q4 of r19: the maps an app builds are checked where it builds them, at module load, never at a violation */
describe("defineConstraintMaps", () => {
	it("refuses a key with a `*` anywhere but its end when it is called, naming the key and the rule", () => {
		expect(() => defineConstraintMaps({ users: {} }, { "ut_*_rows": {} })).toThrow(
			new TypeError('constraint map key "ut_*_rows": a "*" may only end a key, as a prefix pattern such as "ut_*"'),
		)
	})

	it("returns the maps it was given, frozen", () => {
		const users: ConstraintMap = { users: {} }
		const patterned: ConstraintMap = { "ut_*": {} }
		const maps = defineConstraintMaps(users, patterned)
		expect(maps).toEqual([users, patterned])
		expect(Object.isFrozen(maps)).toBe(true)
	})
})

/* Q5 of r20: the README's handler builds its maps array inline, a fresh one per violation */
describe("checkedOnce on an inline maps array per violation", () => {
	it("warns once per malformed key, however many arrays carry its map", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const typoed: ConstraintMap = { "ut_*_rows": {}, "x_*_y": {}, users: {} }
		for (let violation = 0; violation < 3; violation++) checkedOnce([typoed])
		checkedOnce([{ users: {} }, typoed])
		expect(warn.mock.calls.map(([, fields]) => (fields as { key: string }).key)).toEqual(["ut_*_rows", "x_*_y"])
		warn.mockRestore()
	})

	/* Q4 of r21: README's pattern-key shape, `[{ ...DB_CONSTRAINT_MAP, "ut_*": {} }]`, is a new map each time it runs */
	it("warns once per process of a malformed key in a map spread per violation", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const generated: ConstraintMap = { users: {} }
		for (let violation = 0; violation < 3; violation++) checkedOnce([{ ...generated, "sp_*_rows": {} }])
		expect(warn.mock.calls.map(([, fields]) => (fields as { key: string }).key)).toEqual(["sp_*_rows"])
		warn.mockRestore()
	})

	it("says nothing of a map defineConstraintMaps checked, passed in an array of its own", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const checked: ConstraintMap = { "ut_*": {} }
		defineConstraintMaps(checked)
		checkedOnce([checked])
		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})
