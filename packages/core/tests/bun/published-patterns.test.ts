/// <reference types="bun-types" />
/**
 * CS3 of r22b under Bun, which a consumer runs the generated DTOs on: Bun's transpiler writes each
 * non-ASCII character of a regex literal as a `\u` escape, a surrogate pair past U+FFFF, so the
 * literal's `source`, which zod publishes as `pattern`, holds escapes Go's RE2 refuses (it reads no
 * `\u`) and Rust's regex refuses (no surrogate). A pattern comb publishes holds none.
 */
import { afterAll, describe, expect, it } from "bun:test"
import * as z from "zod"
import { cleanGeneratedDtos, generatedDtos } from "../integration/support/dtos.ts"

afterAll(() => cleanGeneratedDtos())

const DECLARED = `export const row = sqliteTable("row", {
	id: c.id("row"),
	letters: c.text("letters", { pattern: "/^\\\\p{L}+$/u" }),
	other: c.text("other", { pattern: "/^[^\\\\P{L}\\\\p{Nd}]$/u" }),
	label: c.text("label", { name: true }),
	accented: c.text("accented", { pattern: "/^[é😀]€$/u" }),
})`

/** Each field's published patterns, keyed by field, from the create DTO's JSON Schema under Bun */
async function publishedPatterns(): Promise<Record<string, string[]>> {
	const dtos = (await generatedDtos("bun-published-patterns", DECLARED))["row"] ?? {}
	const document = z.toJSONSchema(dtos["rowDtoCreateSchema"] as z.ZodObject, { io: "input" })
	const found: Record<string, string[]> = {}
	for (const [key, field] of Object.entries(document.properties ?? {})) {
		const patterns: string[] = []
		JSON.stringify(field, (name, value) => {
			if (name === "pattern" && typeof value === "string") patterns.push(value)
			return value
		})
		if (patterns.length > 0) found[key] = patterns
	}
	return found
}

describe("the patterns comb publishes, read under Bun (CS3 of r22b)", () => {
	it("hold no \\u escape, which Go's RE2 does not compile, nor a surrogate, which Rust's regex refuses", async () => {
		const held = Object.entries(await publishedPatterns()).filter(([, patterns]) =>
			patterns.some((pattern) => /\\u/u.test(pattern)),
		)
		expect(held.map(([key]) => key)).toEqual([])
	})

	it("publish a General_Category by name, which each engine reads in its own Unicode version", async () => {
		const patterns = await publishedPatterns()
		expect([patterns["letters"], patterns["other"], patterns["label"]]).toEqual([
			["^\\p{L}+$"],
			["^[^\\P{L}\\p{Nd}]$"],
			["^[\\p{L}\\p{M}\\p{N}\\p{Zs}\\p{P}]+$"],
		])
	})

	it("publish a declared non-ASCII character as itself, the one spelling ECMAScript, Go and Rust share", async () => {
		expect((await publishedPatterns())["accented"]).toEqual(["^[é😀]€$"])
	})
})
