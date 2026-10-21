import { describe, expect, it } from "vitest"
import { CombError } from "../error.ts"
import {
	createCursor,
	cursorProblem,
	effectiveNulls,
	encodeCursor,
	readCursor,
	sortSignature,
	verifiedCursor,
} from "./cursor.ts"
import { encodeBase64Url } from "./base64url.ts"
import { signPayload } from "./cursor-sign.ts"
import type { SortField } from "./types.ts"
import { CURSOR_SECRET, SIGNED } from "./__fixtures__/cursor-secret.ts"

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

/** Any payload as the cursor wire format writes it, base64url JSON, signed under the test secret */
function wire(body: unknown): string {
	const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(body)))
	return `${encoded}.${signPayload(encoded, CURSOR_SECRET)}`
}

/** Raw payload bytes as a cursor, signed under the test secret */
function signed(bytes: Uint8Array): string {
	const body = encodeBase64Url(bytes)
	return `${body}.${signPayload(body, CURSOR_SECRET)}`
}

/** What the test secret's cursor `cursor` decodes to */
const decoded = (cursor: string) => verifiedCursor(cursor, CURSOR_SECRET)

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
			CURSOR_SECRET,
		)
		expect(decoded(encoded)).toEqual({
			id: "usr_abc123",
			sort: "created_at.desc.nullsfirst",
			values: ["2024-01-01", 42, null],
		})
	})

	it("roundtrips non-ASCII values", () => {
		const encoded = encodeCursor({ i: "id1", s: "", v: ["Žena — 東京"] }, CURSOR_SECRET)
		expect(decoded(encoded)?.values).toEqual(["Žena — 東京"])
	})

	it("roundtrips Date values as Dates", () => {
		const at = new Date("2024-01-01T00:00:00Z")
		expect(decoded(encodeCursor({ i: "id1", s: "", v: [at] }, CURSOR_SECRET))?.values[0]).toEqual(at)
	})

	it("is URL-safe", () => {
		const encoded = encodeCursor({ i: "id?/+", s: "", v: ["???>>>"] }, CURSOR_SECRET)
		expect(encoded).toMatch(/^[\w-]+\.[\w-]{43}$/)
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

	it("returns null for a signed payload that is not UTF-8 JSON", () => {
		expect(decoded(signed(new TextEncoder().encode("{not json")))).toBeNull()
		expect(decoded(signed(new Uint8Array([0xff, 0xfe])))).toBeNull()
	})

	it("returns null for the v1 shape { c, i }", () => {
		expect(decoded(wire({ c: "val", i: "id1" }))).toBeNull()
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
		const cursor = createCursor({ created_at: 5, id: "abc", name: "x" }, sort, SIGNED)
		expect(decoded(cursor)).toEqual({ id: "abc", sort: sortSignature(sort), values: ["x", 5] })
	})

	it("reads the id from a custom field", () => {
		const cursor = createCursor({ _id: "row1", created_at: 1 }, BY_CREATED, { ...SIGNED, idField: "_id" })
		expect(decoded(cursor)?.id).toBe("row1")
	})

	it("records a missing sort value as null", () => {
		expect(decoded(createCursor({ id: "abc" }, BY_CREATED, SIGNED))?.values).toEqual([null])
	})
})

describe("cursorProblem / readCursor", () => {
	const cursor = createCursor({ created_at: 1, id: "abc" }, BY_CREATED, SIGNED)

	it("accepts a cursor under the sort that minted it", () => {
		expect(cursorProblem(cursor, BY_CREATED)).toBeNull()
		expect(readCursor(cursor, BY_CREATED, CURSOR_SECRET).values).toEqual([1])
	})

	it("rejects a cursor under a different sort", () => {
		const other: SortField[] = [{ direction: "asc", field: "created_at" }]
		expect(cursorProblem(cursor, other)).toBe("Cursor was issued for a different order")
		expect(() => readCursor(cursor, other, CURSOR_SECRET)).toThrow(CombError)
	})

	it("rejects garbage with a 400", () => {
		expect(cursorProblem("garbage", BY_CREATED)).toBe("Invalid cursor")
		const error = thrown(() => readCursor("garbage", BY_CREATED, CURSOR_SECRET))
		expect(error).toBeInstanceOf(CombError)
		expect(error).toMatchObject({ errorKey: "invalid_cursor", status: 400 })
	})
})

describe("verifiedCursor — what a cursor may carry (Q-M3, Q-H4)", () => {
	it("keeps a numeric id a number and decodes a tagged date", () => {
		expect(decoded(wire(payload([{ $date: 5 }], 7)))).toEqual({
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
		expect(decoded(wire(body))).toBeNull()
	})

	it("readCursor throws invalid_cursor for one that does not decode", () => {
		expect(() => readCursor("%%%", [{ direction: "desc", field: "created_at" }], CURSOR_SECRET)).toThrow(CombError)
	})
})

describe("signed cursors (Q7)", () => {
	const minted = createCursor({ created_at: 1, id: "abc" }, BY_CREATED, SIGNED)
	const [body, tag] = minted.split(".") as [string, string]
	const invalid = expect.objectContaining({ errorKey: "invalid_cursor", status: 400 })

	it("refuses a cursor a client wrote itself: unsigned, as 0.9 minted it, or with a made-up tag", () => {
		expect(() => readCursor(body, BY_CREATED, CURSOR_SECRET)).toThrow(invalid)
		expect(() => readCursor(`${body}.${"A".repeat(43)}`, BY_CREATED, CURSOR_SECRET)).toThrow(invalid)
	})

	it("refuses a tampered value under the minted tag", () => {
		const tampered = encodeBase64Url(
			new TextEncoder().encode(JSON.stringify({ i: "abc", s: sortSignature(BY_CREATED), v: [73519] })),
		)
		expect(() => readCursor(`${tampered}.${tag}`, BY_CREATED, CURSOR_SECRET)).toThrow(invalid)
	})

	it("refuses a cursor another secret signed", () => {
		expect(() => readCursor(minted, BY_CREATED, `${CURSOR_SECRET}-other`)).toThrow(invalid)
	})

	it("throws a 500 on a secret under 32 bytes, minting or reading", () => {
		const short = expect.objectContaining({ errorKey: "cursor_not_wired", status: 500 })
		expect(() => readCursor(minted, BY_CREATED, "short")).toThrow(short)
		expect(() => createCursor({ id: "abc" }, BY_CREATED, { cursorSecret: "short" })).toThrow(short)
	})

	it("lets the schema check only the shape, which needs no secret: a tag of 43 base64url characters", () => {
		expect(cursorProblem(`${body}.${"A".repeat(43)}`, BY_CREATED)).toBeNull()
		expect(cursorProblem(body, BY_CREATED)).toBe("Invalid cursor")
		expect(cursorProblem(`.${tag}`, BY_CREATED)).toBe("Invalid cursor")
		expect(cursorProblem(`a+b.${tag}`, BY_CREATED)).toBe("Invalid cursor")
	})
})
