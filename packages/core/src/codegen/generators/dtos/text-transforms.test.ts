/**
 * C2 of r19 (K4, C9): every rewrite a written text takes is comb's own, and published. For every text
 * kind and transform a padded, mixed-case input parses to the input with the published list applied,
 * so a rewrite a later zod adds fails here, never a client.
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { isStorableText } from "../../../storable-text.ts"
import { parseField } from "../../__fixtures__/runtime.ts"
import { generateFieldSchema } from "./field-schema.ts"

const OPERATIONS: Record<string, (value: string) => string> = {
	lowercase: (value) => value.toLowerCase(),
	trim: (value) => value.trim(),
	uppercase: (value) => value.toUpperCase(),
}

/* the shared example meta a generated module imports, which says nothing of a value */
const META = new Proxy({}, { get: () => ({}) })

/** The evaluated create schema of a text column declared with `options` */
function written(options: string): z.ZodType {
	const code = generateFieldSchema(parseField("t", `c.text("t", ${options}).notNull()`), "create", {
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
	}) as string
	return new Function("z", "comb", "_m", `return ${code}`)(z, { isStorableText }, META) as z.ZodType
}

/** The transforms `schema` publishes */
const published = (schema: z.ZodType): string[] => {
	const document = z.toJSONSchema(z.object({ t: schema }), { io: "input" }) as unknown as {
		properties: { t: Record<string, unknown> }
	}
	return (document.properties.t["x-comb-transform"] ?? []) as string[]
}

/* each kind with a value it takes once rewritten, padded and in mixed case */
const CASES: ReadonlyArray<[string, string]> = [
	["{}", " Mixed Case "],
	["{ trim: true }", " Mixed Case "],
	["{ lowercase: true }", " Mixed Case "],
	["{ uppercase: true }", " Mixed Case "],
	["{ lowercase: true, trim: true }", " Mixed Case "],
	["{ trim: true, uppercase: true }", " Mixed Case "],
	["{ email: true }", " Ann@Example.COM "],
	["{ url: true }", " https://Example.com/Path "],
	["{ imageUri: true, trim: true }", " https://Example.com/a.png "],
	["{ name: true, trim: true }", " Ann Lee "],
]

describe("a written text's published transforms and what it parses to", () => {
	it.each(CASES)("%s: the value parsed is the input with the published list applied", (options, input) => {
		const schema = written(options)
		const applied = published(schema).reduce((value, name) => (OPERATIONS[name] as (v: string) => string)(value), input)
		expect(schema.parse(input)).toBe(applied)
	})

	it("publishes a url's trim, which is comb's own, with its https rule beside it and no format (A2-8 of r22)", () => {
		const schema = written("{ url: true }")
		expect(published(schema)).toEqual(["trim"])
		expect(z.toJSONSchema(schema, { io: "input" })).toMatchObject({ pattern: "^https:\\/\\/" })
		expect(z.toJSONSchema(schema, { io: "input" })).not.toHaveProperty("format")
		expect(schema.safeParse("https://a.io/x\n").data).toBe("https://a.io/x")
		expect(schema.safeParse("http://a.io").success).toBe(false)
		expect(schema.safeParse(" not a url ").success).toBe(false)
	})

	it("publishes a declared trim on a url once", () => {
		expect(published(written("{ trim: true, url: true }"))).toEqual(["trim"])
	})

	it("leaves a password as written", () => {
		const schema = written("{ password: true }")
		expect(published(schema)).toEqual([])
		expect(schema.parse(" Pass Word1 ")).toBe(" Pass Word1 ")
	})
})
