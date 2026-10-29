import { describe, expect, it } from "vitest"
import * as z from "zod"
import { fieldOf } from "./__fixtures__/runtime.ts"

/* the schema the c.json columns below are given, exported beside the table so the reader finds it */
const schema = z.object({})

/** The constraints a column written as `source` gets, under the property `key` */
const parseFieldConstraints = (source: string, key = "f") => fieldOf(key, source, { scope: { schema } }).constraints

describe("parseFieldConstraints: validation constraints", () => {
	it("extracts min/max from parameter constraints", () => {
		const result = parseFieldConstraints('c.text("email", { min: 5, max: 254 })')
		expect(result.min).toBe(5)
		expect(result.max).toBe(254)
	})

	it("extracts boolean constraints", () => {
		const result = parseFieldConstraints('c.text("email", { email: true, trim: true, lowercase: true })')
		expect(result.email).toBe(true)
		expect(result.trim).toBe(true)
		expect(result.lowercase).toBe(true)
	})

	it("extracts password constraint", () => {
		const result = parseFieldConstraints('c.text("pw", { password: true })')
		expect(result.password).toBe(true)
	})

	it("extracts url constraint", () => {
		const result = parseFieldConstraints('c.text("site", { url: true })')
		expect(result.url).toBe(true)
	})

	it("extracts pattern string", () => {
		const result = parseFieldConstraints('c.text("phone", { pattern: "/^\\\\+[1-9]/" })')
		expect(result.pattern).toBe("/^\\+[1-9]/")
	})
})

describe("parseFieldConstraints: write behavior", () => {
	it("extracts autogenerate", () => {
		const result = parseFieldConstraints('c.text("token", { autogenerate: true })')
		expect(result.autogenerate).toBe(true)
	})

	it("defaults autogenerate to true for timestamp fields", () => {
		const result = parseFieldConstraints('c.createdAt("created_at")', "created_at")
		expect(result.autogenerate).toBe(true)
	})

	it("respects explicit autogenerate: false on timestamp", () => {
		const result = parseFieldConstraints('c.createdAt("created_at", { autogenerate: false })', "created_at")
		expect(result.autogenerate).toBe(false)
	})

	it("extracts nomutate", () => {
		const result = parseFieldConstraints('c.text("id", { nomutate: true })')
		expect(result.nomutate).toBe(true)
	})

	it("detects private from constraint", () => {
		const result = parseFieldConstraints('c.text("secret", { private: true })')
		expect(result.private).toBe(true)
	})

	it("detects private from _ prefix", () => {
		const result = parseFieldConstraints('c.text("_internal")', "_internal")
		expect(result.private).toBe(true)
	})
})

describe("parseFieldConstraints: size and defaults", () => {
	it("extracts maxBytes", () => {
		const result = parseFieldConstraints('c.json("data", schema, { maxBytes: 1024 })')
		expect(result.maxBytes).toBe(1024)
	})

	it("returns defaults for no constraints", () => {
		const result = parseFieldConstraints('c.text("name")')
		expect(result.min).toBeNull()
		expect(result.max).toBeNull()
		expect(result.email).toBe(false)
		expect(result.password).toBe(false)
		expect(result.url).toBe(false)
		expect(result.pattern).toBeNull()
		expect(result.trim).toBe(false)
		expect(result.lowercase).toBe(false)
		expect(result.uppercase).toBe(false)
		expect(result.autogenerate).toBe(false)
		expect(result.nomutate).toBe(false)
		expect(result.private).toBe(false)
		expect(result.maxBytes).toBeNull()
	})
})

describe("parseFieldConstraints: every key the column types allow, and no other (F3)", () => {
	it("reads name and imageUri", () => {
		expect(parseFieldConstraints('c.text("n", { name: true })')).toMatchObject({ imageUri: false, name: true })
		expect(parseFieldConstraints('c.text("a", { imageUri: true })')).toMatchObject({ imageUri: true, name: false })
	})

	it("fails on a key it does not handle, naming it, rather than ignoring it", () => {
		expect(() => parseFieldConstraints('c.text("n", { nmae: true })')).toThrow(
			"/fixture/db.core.tables.ts: fixture.f: comb reads no constraint named nmae",
		)
	})

	it("reads the column's own object argument, never one a later call takes", () => {
		expect(parseFieldConstraints('c.json("m", schema).default({ max: 5 })').max).toBeNull()
		expect(parseFieldConstraints('c.json("m", schema, { maxBytes: 9 }).default({ a: 1 })').maxBytes).toBe(9)
		expect(parseFieldConstraints('c.text("e", { email: true }, 80)').email).toBe(true)
	})
})

describe("parseFieldConstraints: keys that contradict", () => {
	it("refuses mutable and nomutate together", () => {
		expect(() => parseFieldConstraints('c.ref("f", { mutable: true, nomutate: true })')).toThrow(
			"/fixture/db.core.tables.ts: fixture.f: mutable and nomutate contradict; declare one",
		)
	})
})

/* F57: a key may name its relation, as an identifier the generated relations can hold */
describe("parseFieldConstraints: a key's relation", () => {
	it("records the name a key gives its relation, and none by default", () => {
		expect(parseFieldConstraints('c.ref("f", { relation: "owner" }).references(() => user.id)').relation).toBe("owner")
		expect(parseFieldConstraints('c.ref("f").references(() => user.id)').relation).toBeNull()
	})

	it("refuses a relation that is no identifier", () => {
		for (const relation of ["", "has space", "1st"])
			expect(() =>
				parseFieldConstraints(`c.ref("f", { relation: ${JSON.stringify(relation)} }).references(() => user.id)`),
			).toThrow(
				`/fixture/db.core.tables.ts: fixture.f: relation ${JSON.stringify(relation)} is no name a relation can take`,
			)
	})
})

/* C1, C4 of r17: every declared bound is checked once, where it is read, naming the column */
describe("parseFieldConstraints: bounds", () => {
	const at = "/fixture/db.core.tables.ts: fixture.f"

	it.each([
		['c.text("t", { min: 10, max: 2 })', "min 10 is past max 2: no value is both"],
		['c.real("r", { min: 5, max: 1 })', "min 5 is past max 1: no value is both"],
		['c.text("t", { min: -1, max: 3 })', "min -1 is no length: a length is a whole number from 0"],
		['c.text("t", { max: 2.5 })', "max 2.5 is no length: a length is a whole number from 0"],
		['c.json("j", schema, { maxBytes: -1 })', "maxBytes -1 is no size: it is a whole number from 1"],
		['c.json("j", schema, { maxBytes: 0.5 })', "maxBytes 0.5 is no size: it is a whole number from 1"],
	])("refuses %s", (source, reason) => {
		expect(() => parseFieldConstraints(source)).toThrow(`${at}: ${reason}`)
	})

	it("takes bounds that hold a value: equal, fractional on a number, a length from 0", () => {
		expect(parseFieldConstraints('c.text("t", { min: 0, max: 0 })')).toMatchObject({ max: 0, min: 0 })
		expect(parseFieldConstraints('c.real("r", { min: -1.5, max: 2.5 })')).toMatchObject({ max: 2.5, min: -1.5 })
		expect(parseFieldConstraints('c.json("j", schema, { maxBytes: 1 })').maxBytes).toBe(1)
	})
})
