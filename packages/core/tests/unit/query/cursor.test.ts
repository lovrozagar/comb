import { describe, expect, it } from "vitest"
import {
	createCursor,
	decodeCursor,
	encodeCursor,
	getPrimarySortDirection,
	parseCursorForQuery,
} from "../../../src/query/cursor.ts"

describe("cursor encode/decode", () => {
	it("roundtrips a valid payload", () => {
		const payload = { c: "2024-01-01", i: "usr_abc123" }
		const encoded = encodeCursor(payload)
		const decoded = decodeCursor(encoded)
		expect(decoded).toEqual(payload)
	})

	it("handles numeric sort value", () => {
		const payload = { c: 42, i: "id1" }
		const encoded = encodeCursor(payload)
		const decoded = decodeCursor(encoded)
		expect(decoded).toEqual(payload)
	})

	it("handles null sort value", () => {
		const payload = { c: null, i: "id1" }
		const encoded = encodeCursor(payload)
		const decoded = decodeCursor(encoded)
		expect(decoded).toEqual(payload)
	})

	it("returns null for empty string", () => {
		expect(decodeCursor("")).toBeNull()
	})

	it("returns null for null", () => {
		expect(decodeCursor(null)).toBeNull()
	})

	it("returns null for undefined", () => {
		expect(decodeCursor(undefined)).toBeNull()
	})

	it("returns null for invalid base64", () => {
		expect(decodeCursor("not-valid-json!!")).toBeNull()
	})

	it("returns null for valid base64 missing 'i' field", () => {
		const encoded = btoa(JSON.stringify({ c: "val" }))
		expect(decodeCursor(encoded)).toBeNull()
	})
})

describe("createCursor", () => {
	it("creates cursor from record and sort field", () => {
		const record = { createdAt: "2024-01-01", id: "abc" }
		const cursor = createCursor(record, "createdAt")
		const decoded = decodeCursor(cursor)
		expect(decoded).toEqual({ c: "2024-01-01", i: "abc" })
	})

	it("handles missing sort field gracefully", () => {
		const record = { id: "abc" }
		const cursor = createCursor(record, "createdAt")
		const decoded = decodeCursor(cursor)
		expect(decoded).toEqual({ c: undefined, i: "abc" })
	})
})

describe("parseCursorForQuery", () => {
	it("parses valid cursor with sort direction", () => {
		const cursor = encodeCursor({ c: "2024-01-01", i: "id1" })
		const result = parseCursorForQuery(cursor, "desc")
		expect(result).toEqual({
			direction: "desc",
			idValue: "id1",
			sortValue: "2024-01-01",
		})
	})

	it("returns null for invalid cursor", () => {
		expect(parseCursorForQuery("garbage", "asc")).toBeNull()
	})

	it("returns null for null cursor", () => {
		expect(parseCursorForQuery(null, "asc")).toBeNull()
	})
})

describe("getPrimarySortDirection", () => {
	it("returns first sort direction", () => {
		expect(getPrimarySortDirection([{ direction: "asc", field: "name" }])).toBe("asc")
	})

	it("defaults to desc for empty array", () => {
		expect(getPrimarySortDirection([])).toBe("desc")
	})
})
