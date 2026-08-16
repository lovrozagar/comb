import { describe, expect, it } from "vitest"
import { parseFieldConstraints } from "../../../src/codegen/annotations.ts"

describe("parseFieldConstraints", () => {
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
