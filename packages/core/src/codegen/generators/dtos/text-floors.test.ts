/**
 * C3 of r19: a format's shortest value is part of a text's one effective range, so a declared max
 * under it fails codegen, where the field refused every value, and a written value's published
 * minLength is true. Each floor is measured from the check itself, so a change to zod's grammar
 * fails here.
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { isStorableText } from "../../../storable-text.ts"
import { parseField } from "../../__fixtures__/runtime.ts"
import { generateFieldSchema } from "./field-schema.ts"
import { TEXT_FLOORS } from "./text-schema.ts"

const META = new Proxy({}, { get: () => ({}) })

const code = (options: string, notNull = true) =>
	generateFieldSchema(parseField("t", `c.text("t", ${options})${notNull ? ".notNull()" : ""}`), "create", {
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
	}) as string

/** The evaluated create schema of a text column declared with `options` */
const written = (options: string, notNull = true): z.ZodType =>
	new Function("z", "comb", "_m", `return ${code(options, notNull)}`)(z, { isStorableText }, META) as z.ZodType

/** Every string of `length` over `alphabet` */
function stringsOf(length: number, alphabet: string): string[] {
	if (length === 0) return [""]
	return stringsOf(length - 1, alphabet).flatMap((rest) => [...alphabet].map((char) => char + rest))
}

describe("each format's floor, measured from its check", () => {
	it("is the length of the shortest value an email takes", () => {
		const check = z.email()
		expect(check.safeParse("a@b.cc".slice(0, TEXT_FLOORS.email)).success).toBe(true)
		for (let length = 0; length < TEXT_FLOORS.email; length++)
			expect(
				stringsOf(length, "ab@.").filter((value) => check.safeParse(value).success),
				String(length),
			).toEqual([])
	})

	it("is the length of the shortest https URL, and of an imageUri's shorter prefix", () => {
		expect(TEXT_FLOORS.url).toBe("https://a".length)
		expect(z.url().safeParse("https://a").success).toBe(true)
		expect(z.url().safeParse("https://").success).toBe(false)
		expect(TEXT_FLOORS.imageUri).toBe("https://".length)
		const image = written("{ imageUri: true }")
		expect(image.safeParse("https://").success).toBe(true)
		expect(image.safeParse("https:/").success).toBe(false)
	})
})

describe("a text whose declared max is under its format's floor", () => {
	it.each([
		["{ email: true, max: 5 }", "t: its length min 6 and max 5 leave no value; widen them"],
		["{ imageUri: true, max: 7 }", "t: its length min 8 and max 7 leave no value; widen them"],
		["{ max: 8, url: true }", "t: its length min 9 and max 8 leave no value; widen them"],
	])("fails codegen on %s", (options, said) => {
		expect(() => code(options)).toThrow(said)
	})

	it("passes a max at the floor, and takes that value", () => {
		expect(written("{ email: true, max: 6 }").safeParse("a@b.cc").success).toBe(true)
		expect(written("{ imageUri: true, max: 8 }").safeParse("https://").success).toBe(true)
		expect(written("{ max: 9, url: true }").safeParse("https://a").success).toBe(true)
	})
})

describe("a format's floor in what a written text publishes", () => {
	it.each([
		["{ email: true }", 6],
		["{ url: true }", 9],
		["{ imageUri: true }", 8],
		["{ email: true, min: 12 }", 12],
		["{ email: true, min: 2 }", 6],
	])("publishes minLength for %s, on a nullable column's value too", (options, minLength) => {
		expect(z.toJSONSchema(written(options), { io: "input" })).toMatchObject({ minLength })
		expect(z.toJSONSchema(z.object({ t: written(options, false) }), { io: "input" }).properties?.["t"]).toMatchObject({
			anyOf: [{ minLength }, { type: "null" }],
		})
	})
})
