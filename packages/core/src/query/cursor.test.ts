import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import { decodeBase64Url, encodeBase64Url } from "./base64url.ts"
import {
	createCursor,
	cursorProblem,
	effectiveNulls,
	encodeCursor,
	openCursor,
	readCursor,
	sortSignature,
} from "./cursor.ts"
import { seal } from "./cursor-seal.ts"
import type { SortField } from "./types.ts"
import { CURSOR_SECRET, SEALED } from "./__fixtures__/cursor-secret.ts"

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

/** Any payload as JSON, sealed under the test secret and scope */
const wire = (body: unknown): string => seal(new TextEncoder().encode(JSON.stringify(body)), SEALED)

/** Raw payload bytes, sealed under the test secret and scope */
const sealed = (bytes: Uint8Array): string => seal(bytes, SEALED)

/** What the test cursor `cursor` opens to */
const decoded = (cursor: string) => openCursor(cursor, SEALED)

/** Builds a cursor payload under the created_at.desc signature. */
function payload(v: unknown[], i: unknown = 1) {
	return { i, s: "created_at.desc.nullsfirst", v }
}

/** A cursor whose one sort value is the date `time` */
const forged = (time: number) => wire({ i: "id1", s: "", v: [{ $date: time }] })

describe("cursor encode/decode", () => {
	it("roundtrips every value with its sort signature and id", () => {
		const encoded = encodeCursor(
			{ i: "usr_abc123", s: "created_at.desc.nullsfirst", v: ["2024-01-01", 42, null] },
			SEALED,
		)
		expect(decoded(encoded)).toEqual({
			id: "usr_abc123",
			sort: "created_at.desc.nullsfirst",
			values: ["2024-01-01", 42, null],
		})
	})

	it("roundtrips non-ASCII values", () => {
		const encoded = encodeCursor({ i: "id1", s: "", v: ["Žena — 東京"] }, SEALED)
		expect(decoded(encoded)?.values).toEqual(["Žena — 東京"])
	})

	it("roundtrips Date values as Dates", () => {
		const at = new Date("2024-01-01T00:00:00Z")
		expect(decoded(encodeCursor({ i: "id1", s: "", v: [at] }, SEALED))?.values[0]).toEqual(at)
	})

	it("is URL-safe", () => {
		const encoded = encodeCursor({ i: "id?/+", s: "", v: ["???>>>"] }, SEALED)
		expect(encoded).toMatch(/^[\w-]+$/)
	})

	it("returns null for the empty string", () => {
		expect(decoded("")).toBeNull()
	})

	it("returns null for garbage", () => {
		expect(decoded("not-valid-json!!")).toBeNull()
	})

	it("returns null for a date no JS Date holds (Q-D4)", () => {
		expect(decoded(forged(1e300))).toBeNull()
		expect(decoded(forged(-8.64e15 - 1))).toBeNull()
		expect(decoded(forged(8.64e15))?.values).toEqual([new Date(8.64e15)])
	})

	it("returns null for a sealed payload that is not UTF-8 JSON", () => {
		expect(decoded(sealed(new TextEncoder().encode("{not json")))).toBeNull()
		expect(decoded(sealed(new Uint8Array([0xff, 0xfe])))).toBeNull()
	})

	it("returns null for the v1 shape { c, i }", () => {
		expect(decoded(wire({ c: "val", i: "id1" }))).toBeNull()
	})
})

describe("cursor values JSON has no number for (R4)", () => {
	it("carries ±Infinity and NaN as themselves, not as null", () => {
		const encoded = encodeCursor({ i: 1, s: "", v: [Infinity, -Infinity, Number.NaN] }, SEALED)
		expect(decoded(encoded)?.values).toEqual([Infinity, -Infinity, Number.NaN])
	})

	it("opens no other name under the number tag", () => {
		expect(decoded(wire({ i: 1, s: "", v: [{ $num: "infinity" }] }))).toBeNull()
		expect(decoded(wire({ i: 1, s: "", v: [{ $num: 5 }] }))).toBeNull()
	})

	it("mints no cursor from a Date no JS Date holds, which would mean null: a 500 on that page", () => {
		const sort: SortField[] = [{ direction: "asc", field: "at" }]
		expect(() => createCursor({ at: new Date(Number.NaN), id: 1 }, sort, SEALED)).toThrow(
			expect.objectContaining({ errorKey: "sort_not_wired", status: 500 }),
		)
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
		const cursor = createCursor({ created_at: 5, id: "abc", name: "x" }, sort, SEALED)
		expect(decoded(cursor)).toEqual({ id: "abc", sort: sortSignature(sort), values: ["x", 5] })
	})

	it("reads the id from a custom field", () => {
		const cursor = createCursor({ _id: "row1", created_at: 1 }, BY_CREATED, { ...SEALED, idField: "_id" })
		expect(decoded(cursor)?.id).toBe("row1")
	})

	it("records a missing sort value as null", () => {
		expect(decoded(createCursor({ id: "abc" }, BY_CREATED, SEALED))?.values).toEqual([null])
	})
})

describe("cursorProblem / readCursor", () => {
	const cursor = createCursor({ created_at: 1, id: "abc" }, BY_CREATED, SEALED)

	it("accepts a cursor under the sort that minted it", () => {
		expect(cursorProblem(cursor)).toBeNull()
		expect(readCursor(cursor, BY_CREATED, SEALED).values).toEqual([1])
	})

	it("rejects a cursor under a different sort, which only opening it can tell", () => {
		const other: SortField[] = [{ direction: "asc", field: "created_at" }]
		expect(() => readCursor(cursor, other, SEALED)).toThrow(
			expect.objectContaining({ cause: "Cursor was issued for a different order", errorKey: "invalid_cursor" }),
		)
	})

	it("rejects garbage with a 400", () => {
		expect(cursorProblem("garbage")).toBe("Invalid cursor")
		const error = thrown(() => readCursor("garbage", BY_CREATED, SEALED))
		expect(error).toBeInstanceOf(CombError)
		expect(error).toMatchObject({ errorKey: "invalid_cursor", status: 400 })
	})
})

describe("openCursor — what a cursor may carry (Q-M3, Q-H4)", () => {
	it("keeps a numeric id a number and decodes a tagged date", () => {
		expect(decoded(wire(payload([{ $date: 5 }], 7)))).toEqual({
			id: 7,
			sort: "created_at.desc.nullsfirst",
			values: [new Date(5)],
		})
	})

	it.each([
		["a non-object payload", 5],
		["a null payload", null],
		["a boolean id", payload([1], true)],
		["an object value", payload([{ x: 1 }])],
		["a date tag beside another key", payload([{ $date: 1, x: 2 }])],
		["a date tag that is not a number", payload([{ $date: "nope" }])],
		["an array value", payload([[1]])],
	])("is null for %s", (_label, body) => {
		expect(decoded(wire(body))).toBeNull()
	})

	it("readCursor throws invalid_cursor for one that does not decode", () => {
		expect(() => readCursor("%%%", [{ direction: "desc", field: "created_at" }], SEALED)).toThrow(CombError)
	})
})

describe("sealed and scoped cursors (R1, R2)", () => {
	const minted = createCursor(
		{ created_at: 1, id: "abc", salary: 73519 },
		[{ direction: "desc", field: "salary" }],
		SEALED,
	)
	const bySalary: SortField[] = [{ direction: "desc", field: "salary" }]
	const invalid = expect.objectContaining({ errorKey: "invalid_cursor", status: 400 })

	it("hands a client no sort value: the cursor's bytes hold none of the row's salary", () => {
		const raw = String.fromCharCode(...(decodeBase64Url(minted) as Uint8Array))
		expect(raw).not.toContain("73519")
		expect(minted).not.toContain(encodeBase64Url(new TextEncoder().encode('"v":[73519]')).slice(0, 8))
		expect(readCursor(minted, bySalary, SEALED).values).toEqual([73519])
	})

	it("refuses a cursor a client wrote itself: 0.10's signed shape, plain JSON, or bytes of its own", () => {
		const json = encodeBase64Url(
			new TextEncoder().encode(JSON.stringify({ i: "abc", s: sortSignature(bySalary), v: [1] })),
		)
		for (const forgery of [`${json}.${"A".repeat(43)}`, json, encodeBase64Url(new Uint8Array(64).fill(1))])
			expect(() => readCursor(forgery, bySalary, SEALED)).toThrow(invalid)
	})

	it("refuses a cursor minted in another scope, the same secret and sort notwithstanding", () => {
		expect(() => readCursor(minted, bySalary, { ...SEALED, cursorScope: "test:other-tenant" })).toThrow(invalid)
	})

	it("refuses a tampered cursor, and one spelled another way", () => {
		const raw = decodeBase64Url(minted) as Uint8Array
		const tampered = encodeBase64Url(raw.map((byte, i) => (i === raw.length - 20 ? byte ^ 1 : byte)))
		expect(() => readCursor(tampered, bySalary, SEALED)).toThrow(invalid)
		expect(() => readCursor(`${minted}A`, bySalary, SEALED)).toThrow(invalid)
	})

	it("refuses a cursor another secret sealed", () => {
		expect(() => readCursor(minted, bySalary, { ...SEALED, cursorSecret: `${CURSOR_SECRET}-other` })).toThrow(invalid)
	})

	it("throws a 500 on a secret under 32 bytes or no scope, minting or reading", () => {
		const unwired = expect.objectContaining({ errorKey: "cursor_not_wired", status: 500 })
		expect(() => readCursor(minted, bySalary, { ...SEALED, cursorSecret: "short" })).toThrow(unwired)
		expect(() => createCursor({ id: "abc" }, BY_CREATED, { ...SEALED, cursorScope: "" })).toThrow(unwired)
		expect(() => createCursor({ id: "abc" }, BY_CREATED, undefined as unknown as typeof SEALED)).toThrow(unwired)
	})

	it("lets the schema check only the shape, which needs no secret", () => {
		expect(cursorProblem(minted)).toBeNull()
		expect(cursorProblem(`${minted.slice(0, 10)}.${"A".repeat(43)}`)).toBe("Invalid cursor")
		expect(cursorProblem("")).toBe("Invalid cursor")
		expect(cursorProblem(`a+b${minted}`)).toBe("Invalid cursor")
	})
})
