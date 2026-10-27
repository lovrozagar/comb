import { describe, expect, it } from "vitest"
import { CursorRef, mintCursor, openCursor } from "./cursor.ts"
import { createCursor } from "./cursor-mint.ts"
import { createCursor as publicCreateCursor, MAX_CURSOR_LENGTH, readCursor } from "./index.ts"
import type { SortField } from "./types.ts"
import { SEALED } from "./__fixtures__/cursor-secret.ts"

const BY_TITLE: SortField[] = [{ direction: "asc", field: "title" }]
const wide = "€".repeat(3000)

describe("createCursor", () => {
	it("mints a cursor as it is while it fits the cap", () => {
		expect(openCursor(createCursor({ id: 1, title: "short" }, BY_TITLE, SEALED), SEALED)?.values).toEqual(["short"])
	})

	it("carries an overflowing value by the longest prefix of it that fits, within the cap", () => {
		const title = `${"長".repeat(3000)}tail`
		const cursor = createCursor({ id: 1, title }, BY_TITLE, SEALED)
		expect(cursor.length).toBeLessThanOrEqual(8192)
		const [ref] = openCursor(cursor, SEALED)?.values ?? []
		expect(ref).toBeInstanceOf(CursorRef)
		const { prefix } = ref as CursorRef
		expect(title.startsWith(prefix)).toBe(true)
		/* one more code point of prefix would not fit */
		const longer = Array.from(title)
			.slice(0, Array.from(prefix).length + 1)
			.join("")
		expect((ref as CursorRef).length).toBe(Array.from(title).length)
		const wider = new CursorRef(longer, Array.from(title).length)
		expect(mintCursor({ id: 1, title: wider }, BY_TITLE, SEALED).length).toBeGreaterThan(8192)
	})

	it("carries the longest values first, each by what room the others leave", () => {
		const sort: SortField[] = [
			{ direction: "asc", field: "a" },
			{ direction: "asc", field: "b" },
		]
		const cursor = createCursor({ a: "甲".repeat(4000), b: "乙".repeat(3500), id: 1 }, sort, SEALED)
		const [a, b] = openCursor(cursor, SEALED)?.values ?? []
		expect(cursor.length).toBeLessThanOrEqual(8192)
		expect(a).toEqual(new CursorRef("", 4000))
		expect(b).toBeInstanceOf(CursorRef)
	})

	it("refuses a derived list's overflow, and one no reference can bring under the cap, with a 500", () => {
		const derived = { ...SEALED, keyset: "derived" as const }
		expect(() => createCursor({ id: 1, title: "長".repeat(3000) }, BY_TITLE, derived)).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("a derived list reads no row"), status: 500 }),
		)
		const huge = BigInt(`1${"0".repeat(7000)}`)
		expect(() => createCursor({ id: 1, title: huge }, BY_TITLE, SEALED)).toThrow(
			expect.objectContaining({ cause: expect.stringContaining("the other keys leave no room"), status: 500 }),
		)
	})
})

/* U37: the public createCursor, as a caller that mints its own cursor uses it (the README's derived list), mints as paginate does */

describe("the public createCursor: a value too long for a cursor", () => {
	it("carries a long value of a table's row by reference, within the cap readCursor holds", () => {
		const cursor = publicCreateCursor({ id: "p1", title: wide }, BY_TITLE, SEALED)
		expect(cursor.length).toBeLessThanOrEqual(MAX_CURSOR_LENGTH)
		expect(readCursor(cursor, BY_TITLE, SEALED)?.id).toBe("p1")
	})

	it("refuses one on a derived list's row, which no row holds to read back, with sort_not_wired", () => {
		expect(() =>
			publicCreateCursor({ _id: "d1", title: wide }, BY_TITLE, { ...SEALED, idField: "_id", keyset: "derived" }),
		).toThrow(expect.objectContaining({ errorKey: "sort_not_wired" }))
	})

	it("mints a short row's cursor whole, under its own idField", () => {
		const cursor = publicCreateCursor({ _id: "d1", title: "a" }, BY_TITLE, {
			...SEALED,
			idField: "_id",
			keyset: "derived",
		})
		expect(readCursor(cursor, BY_TITLE, SEALED)).toMatchObject({ id: "d1", values: ["a"] })
	})
})
