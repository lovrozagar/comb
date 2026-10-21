import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import {
	createCursor,
	cursorProblem,
	decodeCursor,
	effectiveNulls,
	encodeCursor,
	readCursor,
	sortSignature,
} from "./cursor.ts"
import type { SortField } from "./types.ts"

const BY_CREATED: SortField[] = [{ direction: "desc", field: "created_at" }]

/** Runs `fn` and returns what it threw; fails the test if it returns normally. */
function thrown(fn: () => unknown): unknown {
	try {
		fn()
	} catch (error) {
		return error
	}
	throw new Error("expected the call to throw")
}

/** Encodes any payload the way the cursor wire format does (base64url, unpadded). */
function wire(body: unknown): string {
	return btoa(JSON.stringify(body)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Builds a cursor payload under the created_at.desc signature. */
function payload(v: unknown[], i: unknown = 1) {
	return { i, s: "created_at.desc.nullsfirst", v }
}

/** A cursor whose one sort value is the date `time` */
const forged = (time: number) => btoa(JSON.stringify({ i: "id1", s: "", v: [{ $date: time }] }))

describe("cursor encode/decode", () => {
	it("roundtrips every value with its sort signature and id", () => {
		const encoded = encodeCursor({ i: "usr_abc123", s: "created_at.desc.nullsfirst", v: ["2024-01-01", 42, null] })
		expect(decodeCursor(encoded)).toEqual({
			id: "usr_abc123",
			sort: "created_at.desc.nullsfirst",
			values: ["2024-01-01", 42, null],
		})
	})

	it("roundtrips non-ASCII values", () => {
		const encoded = encodeCursor({ i: "id1", s: "", v: ["Žena — 東京"] })
		expect(decodeCursor(encoded)?.values).toEqual(["Žena — 東京"])
	})

	it("roundtrips Date values as Dates", () => {
		const at = new Date("2024-01-01T00:00:00Z")
		const decoded = decodeCursor(encodeCursor({ i: "id1", s: "", v: [at] }))
		expect(decoded?.values[0]).toEqual(at)
	})

	it("is URL-safe", () => {
		const encoded = encodeCursor({ i: "id?/+", s: "", v: ["???>>>"] })
		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
	})

	it("returns null for empty, null and undefined", () => {
		expect(decodeCursor("")).toBeNull()
		expect(decodeCursor(null)).toBeNull()
		expect(decodeCursor(undefined)).toBeNull()
	})

	it("returns null for garbage", () => {
		expect(decodeCursor("not-valid-json!!")).toBeNull()
	})

	it("returns null for a date no JS Date holds (Q-D4)", () => {
		expect(decodeCursor(forged(1e300))).toBeNull()
		expect(decodeCursor(forged(-8.64e15 - 1))).toBeNull()
		expect(decodeCursor(forged(8.64e15))?.values).toEqual([new Date(8.64e15)])
	})

	it("returns null for the v1 shape { c, i }", () => {
		expect(decodeCursor(btoa(JSON.stringify({ c: "val", i: "id1" })))).toBeNull()
	})
})

describe("sortSignature", () => {
	it("spells out the effective null placement", () => {
		expect(sortSignature([{ direction: "asc", field: "name" }])).toBe("name.asc.nullslast")
		expect(sortSignature([{ direction: "desc", field: "name" }])).toBe("name.desc.nullsfirst")
		expect(sortSignature([{ direction: "desc", field: "name", nulls: "last" }])).toBe("name.desc.nullslast")
	})

	it("treats the default and the explicit placement as the same sort", () => {
		expect(sortSignature([{ direction: "asc", field: "a", nulls: "last" }])).toBe(
			sortSignature([{ direction: "asc", field: "a" }]),
		)
	})
})

describe("effectiveNulls", () => {
	it("follows PostgreSQL defaults", () => {
		expect(effectiveNulls("asc")).toBe("last")
		expect(effectiveNulls("desc")).toBe("first")
		expect(effectiveNulls("asc", "first")).toBe("first")
	})
})

describe("createCursor", () => {
	it("captures every sort key and the id", () => {
		const sort: SortField[] = [
			{ direction: "asc", field: "name" },
			{ direction: "desc", field: "created_at" },
		]
		const cursor = createCursor({ created_at: 5, id: "abc", name: "x" }, sort)
		expect(decodeCursor(cursor)).toEqual({ id: "abc", sort: sortSignature(sort), values: ["x", 5] })
	})

	it("reads the id from a custom field", () => {
		const cursor = createCursor({ _id: "row1", created_at: 1 }, BY_CREATED, { idField: "_id" })
		expect(decodeCursor(cursor)?.id).toBe("row1")
	})

	it("records a missing sort value as null", () => {
		expect(decodeCursor(createCursor({ id: "abc" }, BY_CREATED))?.values).toEqual([null])
	})
})

describe("cursorProblem / readCursor", () => {
	const cursor = createCursor({ created_at: 1, id: "abc" }, BY_CREATED)

	it("accepts a cursor under the sort that minted it", () => {
		expect(cursorProblem(cursor, BY_CREATED)).toBeNull()
		expect(readCursor(cursor, BY_CREATED).values).toEqual([1])
	})

	it("rejects a cursor under a different sort", () => {
		const other: SortField[] = [{ direction: "asc", field: "created_at" }]
		expect(cursorProblem(cursor, other)).toBe("Cursor was issued for a different order")
		expect(() => readCursor(cursor, other)).toThrow(CombError)
	})

	it("rejects garbage with a 400", () => {
		expect(cursorProblem("garbage", BY_CREATED)).toBe("Invalid cursor")
		const error = thrown(() => readCursor("garbage", BY_CREATED))
		expect(error).toBeInstanceOf(CombError)
		expect(error).toMatchObject({ errorKey: "invalid_cursor", status: 400 })
	})
})

describe("decodeCursor — what a cursor may carry (Q-M3, Q-H4)", () => {
	it("keeps a numeric id a number and decodes a tagged date", () => {
		expect(decodeCursor(wire(payload([{ $date: 5 }], 7)))).toEqual({
			id: 7,
			sort: "created_at.desc.nullsfirst",
			values: [new Date(5)],
		})
	})

	it.each([
		["a non-object payload", 5],
		["a boolean id", payload([1], true)],
		["an object value", payload([{ x: 1 }])],
		["a date tag beside another key", payload([{ $date: 1, x: 2 }])],
		["a date tag that is not a number", payload([{ $date: "nope" }])],
		["an array value", payload([[1]])],
	])("is null for %s", (_label, body) => {
		expect(decodeCursor(wire(body))).toBeNull()
	})

	it("readCursor throws invalid_cursor for one that does not decode", () => {
		expect(() => readCursor("%%%", [{ direction: "desc", field: "created_at" }])).toThrow(CombError)
	})
})
