/**
 * B2-6 of area B: a list that binds a time key by the value it stores (a SQLite timestamp's epoch
 * number, a Postgres time's text) minted a cursor readCursor opened to that value, where the row
 * read a Date. readCursor hands back the Date the row read, an Invalid one included, and the keyset
 * still binds the stored value; the Date rides in the cursor and counts against its cap. AB3-3 of
 * area B widens it to every key the list re-types: a numeric's text read as a bigint, a null read
 * for Infinity, bytes read as an ArrayBuffer.
 */
import { describe, expect, it } from "vitest"
import { CursorRef, mintCursor, openCursor, readCursor } from "./cursor.ts"
import { fitCursor } from "./cursor-mint.ts"
import { queryHelpers } from "./drizzle.ts"
import { createListQuerySchema } from "./schema.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"
import { built } from "./__fixtures__/built.ts"
import { seal } from "./cursor-seal.ts"

const schema = createListQuerySchema({ sort: ["at", "n", "title"] })
const query = schema.parse({ limit: "1", order: "at.asc,n.asc,title.asc" })
const derived = built(query, { ...SEALED, keyset: "derived" })

/** The next cursor of a derived page whose last row is `row`, its keys' stored values in `texts` */
const next = (row: Record<string, unknown>, texts: string): string =>
	queryHelpers.paginate(
		[
			{ _combId: "a", _combKeyTexts: texts, id: "a", ...row },
			{ _combId: "b", _combKeyTexts: ",,", at: new Date(9), id: "b", n: 9, title: "x" },
		],
		derived,
	)[1].nextCursor as string

/** The next cursor of a row whose title is `n` code points long, its two time keys carried as stored */
const long = (n: number): string => next({ at: new Date(1), n: new Date(2), title: "字".repeat(n) }, "1.5,2.5,")

/** Any payload as JSON, sealed under the test secret and scope */
const wire = (body: unknown): string => seal(new TextEncoder().encode(JSON.stringify(body)), SEALED)

describe("readCursor returns each key as the cursor's row read it (B2-6 of area B; sibling: the carried flag)", () => {
	it("returns the Date a row read, an Invalid one included, where the keyset binds the stored value", () => {
		const cursor = next({ at: new Date(1), n: new Date(Number.NaN), title: "t" }, "1.5,7,")
		const { carried, values } = readCursor(cursor, query.parsedSort, SEALED)
		expect(values.slice(0, 2)).toEqual([new Date(1), expect.any(Date)])
		expect((values[1] as Date).getTime()).toBeNaN()
		expect(values[2]).toBe("t")
		expect(carried).toEqual([false, false, false])
		expect(openCursor(cursor, SEALED)?.values).toEqual([1.5, 7, "t"])
	})

	it("carries no Date for a key bound as the row read it, which readCursor returns as it is", () => {
		const cursor = next({ at: new Date(1), n: 3, title: "t" }, ",,")
		expect(openCursor(cursor, SEALED)).not.toHaveProperty("read")
		expect(readCursor(cursor, query.parsedSort, SEALED).values).toEqual([new Date(1), 3, "t"])
	})

	it("refuses a cursor whose Dates are no epoch time, null or invalid, one a key", () => {
		const payload = { i: "a", s: "created_at.desc.nullsfirst", v: ["12"] }
		for (const d of [["valid"], [true], [{}], 5, null, [1, 2]])
			expect(openCursor(wire({ ...payload, d }), SEALED), JSON.stringify(d)).toBeNull()
		expect(openCursor(wire({ ...payload, d: [null] }), SEALED)).toMatchObject({ values: ["12"] })
		expect(openCursor(wire({ ...payload, d: [5] }), SEALED)).toMatchObject({ values: ["12"] })
	})

	it("counts the Dates against the cap, and names the keys of a derived row past it", () => {
		const fits = (n: number) => {
			try {
				return long(n).length > 0
			} catch {
				// reason: a row past the cap is the refusal this test pins below; here it only marks the bound
				return false
			}
		}
		let [low, high] = [1, 4096]
		while (low < high) {
			const mid = Math.ceil((low + high) / 2)
			if (fits(mid)) low = mid
			else high = mid - 1
		}
		expect(long(low).length).toBeLessThanOrEqual(8192)
		expect(readCursor(long(low), query.parsedSort, SEALED).values.slice(0, 2)).toEqual([new Date(1), new Date(2)])
		expect(openCursor(long(low), SEALED)?.values.slice(0, 2)).toEqual([1.5, 2.5])
		expect(() => long(low + 1)).toThrow(
			expect.objectContaining({
				cause: expect.stringMatching(
					/^a row's at, n, title is too long to page this list by: its cursor would be \d+ characters, past 8192; a derived list reads no row/,
				),
				errorKey: "sort_not_wired",
			}),
		)
	})
})

const BY_K = [{ direction: "asc", field: "k" }] as const

/** The key readCursor opens from a cursor minted for a row whose key binds as `bound` and was read as `read` */
const back = (bound: unknown, read: unknown): unknown =>
	readCursor(mintCursor({ id: "a", k: bound }, BY_K, { ...SEALED, read: { k: read } }), BY_K, SEALED).values[0]

describe("readCursor returns every key the list re-types as its row read it (AB3-3 of area B)", () => {
	it("returns the read value where the keyset binds another, a read null told from a key read as bound", () => {
		expect(back(10n, "10")).toBe("10")
		expect(back("0.1000000000000000001", 0.1)).toBe(0.1)
		expect(back(Number.POSITIVE_INFINITY, null)).toBeNull()
		expect(back(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
		expect(back(5, undefined)).toBe(5)
	})

	it("returns bytes read as an ArrayBuffer or D1's array as a Uint8Array, and bytes read as bound as the bound", () => {
		const bytes = Uint8Array.from([1, 2])
		expect(back(bytes, bytes.buffer)).toEqual(bytes)
		expect(back(bytes, [1, 2])).toEqual(bytes)
		expect(
			openCursor(mintCursor({ id: "a", k: bytes }, BY_K, { ...SEALED, read: { k: [1, 2] } }), SEALED),
		).not.toHaveProperty("read")
	})

	it("carries no read for a long key read as bound, which goes by reference, and the read of one read as another", () => {
		const key = "字".repeat(3000)
		const by = (read: unknown) =>
			readCursor(fitCursor({ id: "a", k: key }, BY_K, { ...SEALED, read: { k: read } }), BY_K, SEALED).values[0]
		expect(by(key)).toEqual(expect.any(CursorRef))
		expect((by(new Date(Number.NaN)) as Date).getTime()).toBeNaN()
	})

	it("carries no read no cursor carries, which readCursor answers with the bound", () => {
		expect(back("x", { json: true })).toBe("x")
		expect(back("x", [1, 2])).toBe("x")
	})

	it("reads a cursor's read values as one slot each, a released Date form included, and refuses any other slot", () => {
		const payload = { i: "a", s: "k.asc.nullslast", v: [7] }
		const opened = (d: unknown) => openCursor(wire({ ...payload, d }), SEALED)
		expect(readCursor(wire({ ...payload, d: [["7"]] }), BY_K, SEALED).values).toEqual(["7"])
		expect(readCursor(wire({ ...payload, d: [[null]] }), BY_K, SEALED).values).toEqual([null])
		expect(readCursor(wire({ ...payload, d: [[{ $bigint: "7" }]] }), BY_K, SEALED).values).toEqual([7n])
		expect((readCursor(wire({ ...payload, d: ["invalid"] }), BY_K, SEALED).values[0] as Date).getTime()).toBeNaN()
		for (const d of [[[]], [[1, 2]], [[{ $ref: ["a", 3] }]], [[{ $no: 1 }]], [[{}]]])
			expect(opened(d), JSON.stringify(d)).toBeNull()
	})
})
