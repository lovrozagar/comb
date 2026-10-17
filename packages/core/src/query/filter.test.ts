import { describe, expect, it } from "vitest"
import { parseOrder } from "./filter.ts"

describe("parseOrder", () => {
	/* empty-input parity */
	it("returns empty for null", () => {
		expect(parseOrder(null)).toEqual([])
	})

	it("returns empty for undefined", () => {
		expect(parseOrder(undefined)).toEqual([])
	})

	it("returns empty for empty string", () => {
		expect(parseOrder("")).toEqual([])
	})

	it("returns empty for whitespace-only", () => {
		expect(parseOrder("   ")).toEqual([])
	})

	/* single-field direction */
	it("parses bare field as asc default", () => {
		expect(parseOrder("name")).toEqual([{ direction: "asc", field: "name" }])
	})

	it("parses field.asc explicitly", () => {
		expect(parseOrder("name.asc")).toEqual([{ direction: "asc", field: "name" }])
	})

	it("parses field.desc", () => {
		expect(parseOrder("createdAt.desc")).toEqual([{ direction: "desc", field: "createdAt" }])
	})

	/* null ordering */
	it("parses field.nullsfirst (asc default)", () => {
		expect(parseOrder("name.nullsfirst")).toEqual([{ direction: "asc", field: "name", nulls: "first" }])
	})

	it("parses field.nullslast (asc default)", () => {
		expect(parseOrder("name.nullslast")).toEqual([{ direction: "asc", field: "name", nulls: "last" }])
	})

	it("parses field.asc.nullsfirst", () => {
		expect(parseOrder("name.asc.nullsfirst")).toEqual([{ direction: "asc", field: "name", nulls: "first" }])
	})

	it("parses field.asc.nullslast", () => {
		expect(parseOrder("name.asc.nullslast")).toEqual([{ direction: "asc", field: "name", nulls: "last" }])
	})

	it("parses field.desc.nullsfirst", () => {
		expect(parseOrder("createdAt.desc.nullsfirst")).toEqual([{ direction: "desc", field: "createdAt", nulls: "first" }])
	})

	it("parses field.desc.nullslast", () => {
		expect(parseOrder("createdAt.desc.nullslast")).toEqual([{ direction: "desc", field: "createdAt", nulls: "last" }])
	})

	/* multi-field */
	it("parses comma-separated fields", () => {
		expect(parseOrder("col1.desc,col2.asc")).toEqual([
			{ direction: "desc", field: "col1" },
			{ direction: "asc", field: "col2" },
		])
	})

	it("parses mixed with nulls", () => {
		expect(parseOrder("col1.desc,col2.asc.nullsfirst")).toEqual([
			{ direction: "desc", field: "col1" },
			{ direction: "asc", field: "col2", nulls: "first" },
		])
	})

	it("skips empty comma parts", () => {
		const result = parseOrder(",name.asc,,")
		expect(result).toHaveLength(1)
		expect(result[0]?.field).toBe("name")
	})

	it("trims whitespace around parts", () => {
		const result = parseOrder(" col1.desc , col2.asc ")
		expect(result).toHaveLength(2)
		expect(result[0]?.field).toBe("col1")
		expect(result[1]?.field).toBe("col2")
	})

	/* computed fields (anyrow @ prefix) */
	it("preserves @ prefix on computed fields", () => {
		expect(parseOrder("@totalPrice.desc")).toEqual([{ direction: "desc", field: "@totalPrice" }])
	})

	it("computed field with nulls suffix", () => {
		expect(parseOrder("@score.desc.nullslast")).toEqual([{ direction: "desc", field: "@score", nulls: "last" }])
	})

	/* edge cases / malformed input */
	it("rejects JSON:API '-' prefix (no longer supported)", () => {
		/* '-' is not a known suffix token — parser emits literal field name */
		expect(parseOrder("-name")).toEqual([{ direction: "asc", field: "-name" }])
	})

	it("rejects JSON:API '+' prefix (no longer supported)", () => {
		/* '+' is not a known suffix token — parser emits literal field name */
		expect(parseOrder("+name")).toEqual([{ direction: "asc", field: "+name" }])
	})

	it("ignores unknown direction token", () => {
		/* 'foo' not a known suffix — stays joined as literal field name */
		expect(parseOrder("name.foo")).toEqual([{ direction: "asc", field: "name.foo" }])
	})

	/* field name integrity */
	it("handles dotted relation field path", () => {
		/* right-to-left peel: 'asc' consumed, remainder 'author.name' is the field */
		expect(parseOrder("author.name.asc")).toEqual([{ direction: "asc", field: "author.name" }])
	})
})

describe("parseOrder — malformed input", () => {
	it("returns nothing for empty or absent input", () => {
		expect(parseOrder("")).toEqual([])
		expect(parseOrder(null)).toEqual([])
		expect(parseOrder(undefined)).toEqual([])
	})

	it("skips empty segments between commas", () => {
		expect(parseOrder("created_at.desc,,title.asc")).toHaveLength(2)
	})

	it("skips a segment that names no field", () => {
		expect(parseOrder(".desc")).toEqual([])
		/* a bare direction is consumed as the direction, leaving no field behind */
		expect(parseOrder("asc")).toEqual([])
	})

	it("defaults to ascending when no direction is given", () => {
		expect(parseOrder("title")).toEqual([{ direction: "asc", field: "title" }])
	})

	it("reads null placement off the end of the segment", () => {
		expect(parseOrder("title.desc.nullslast")).toEqual([{ direction: "desc", field: "title", nulls: "last" }])
		expect(parseOrder("title.nullsfirst")).toEqual([{ direction: "asc", field: "title", nulls: "first" }])
	})
})
