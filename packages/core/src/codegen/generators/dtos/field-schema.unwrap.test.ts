/**
 * C1 of r20: a consumer composes a generated field through zod, most often taking a nullable column
 * as a required input with `.unwrap()`. The field's `x-comb-*` keys must survive that, as they
 * survive `.optional()` and `.pick()`, so the composed schema publishes what the field enforces.
 */
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { jsonValue } from "../../../json-value.ts"
import { isStorableText } from "../../../storable-text.ts"
import { parseField } from "../../__fixtures__/runtime.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"

/* the shared example meta a generated module imports, which says nothing of a value */
const META = new Proxy({}, { get: () => ({}) })
const Doc = z.object({ a: z.string() })
/* the shared file's JSON value, as timestamps.ts writes it */
const jsonValueSchema = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.array(jsonValue),
	z.record(z.string(), jsonValue),
])

/** The evaluated `schemaType` schema of the nullable column `raw` */
function generated(raw: string, schemaType: SchemaType, dialect: "postgres" | "sqlite"): z.ZodType {
	const field = {
		...parseField("t", raw, { dialect, scope: { Doc } }),
		jsonSchemaName: raw.includes("Doc") ? "Doc" : null,
	}
	const code = generateFieldSchema(field, schemaType, {
		dialect,
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
	}) as string
	return new Function("z", "comb", "_m", "Doc", "jsonValueSchema", ts.transpile(`return ${code}`))(
		z,
		{ isStorableText, jsonValue },
		META,
		Doc,
		jsonValueSchema,
	)
}

/** The `x-comb-*` keys and values an object's property `t` publishes */
function keysOf(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
	const document = z.toJSONSchema(z.object({ t: schema }), { io, unrepresentable: "any" }) as unknown as {
		properties: { t: Record<string, unknown> }
	}
	return Object.fromEntries(Object.entries(document.properties.t).filter(([key]) => key.startsWith("x-comb-")))
}

/** `schema` taken as required: every optional and nullable wrapper unwrapped, as a consumer does */
function required(schema: z.ZodType): z.ZodType {
	let at = schema
	while (at instanceof z.ZodOptional || at instanceof z.ZodNullable) at = at.unwrap() as z.ZodType
	return at
}

/* every kind that publishes keys, nullable, in a DTO that publishes them */
const KINDS: ReadonlyArray<[string, string, SchemaType, "postgres" | "sqlite"]> = [
	["a trimmed bounded text", 'c.text("t", { max: 9, trim: true })', "create", "sqlite"],
	["a lowercased text", 'c.text("t", { lowercase: true })', "update", "sqlite"],
	["an email", 'c.text("t", { email: true })', "create", "sqlite"],
	["a url", 'c.text("t", { url: true })', "update", "postgres"],
	["a bounded text's read", 'c.text("t", { max: 9, min: 2 })', "read", "sqlite"],
	["an integer's read bounds", 'c.integer("t", { max: 9, min: 1 })', "read", "sqlite"],
	["a real's read bounds", 'c.real("t", { max: 1, min: 0 })', "read", "postgres"],
	["a c.json with maxBytes", 'c.json("t", Doc, { maxBytes: 64 })', "create", "sqlite"],
	["a plain jsonb", 'jsonb("t")', "create", "postgres"],
]

describe("a nullable field keeps its keys through unwrap (C1); siblings: .optional(), .pick()", () => {
	for (const [kind, raw, schemaType, dialect] of KINDS) {
		const io = schemaType === "read" ? "output" : "input"
		const field = generated(raw, schemaType, dialect)
		const published = keysOf(field, io)

		it(`${kind}: the field publishes keys, and taken as required publishes the same`, () => {
			expect(Object.keys(published).length).toBeGreaterThan(0)
			expect(keysOf(required(field), io)).toEqual(published)
		})

		it(`${kind}: required then .optional(), and .pick() of an object holding it, publish them too`, () => {
			expect(keysOf(required(field).optional(), io)).toEqual(published)
			const picked = z.object({ t: required(field), u: z.string() }).pick({ t: true }).shape.t
			expect(keysOf(picked, io)).toEqual(published)
		})
	}

	it("a Postgres array's nullable element keeps its keys through unwrap", () => {
		const array = required(generated('text("t").array()', "create", "postgres")) as z.ZodArray
		const element = array.element as z.ZodType
		expect(keysOf(required(element), "input")).toEqual(keysOf(element, "input"))
		expect(Object.keys(keysOf(element, "input"))).toEqual(["x-comb-text"])
	})
})
