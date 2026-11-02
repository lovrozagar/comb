/**
 * C4 and C5 of r18: a written c.json publishes one flat union, null in it when the column takes null,
 * and a registered schema stays a bare `$ref` whatever rules it takes, its rules in x- keys beside it.
 */
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { fieldOf } from "../../__fixtures__/runtime.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"

/* a schema an app registers with an id, which a document publishes once under $defs */
const Profile = z.object({ bio: z.string() }).meta({ description: "A member's profile", id: "C4Profile" })

/** The generated schema of a c.json column of Profile written as `raw`, evaluated */
function profile(raw: string, schemaType: SchemaType): z.ZodType {
	const field = { ...fieldOf("p", raw, { scope: { Profile } }), jsonSchemaName: "Profile" }
	const code = generateFieldSchema(field, schemaType, {
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
	}) as string
	return new Function("z", "Profile", `return ${code}`)(z, Profile) as z.ZodType
}

/** What an object of the one field `p` publishes for it, and its $defs */
function published(schema: z.ZodType) {
	const document = z.toJSONSchema(z.object({ p: schema }), { io: "input" }) as unknown as {
		$defs?: Record<string, unknown>
		properties: { p: Record<string, unknown> }
	}
	return { defs: Object.keys(document.$defs ?? {}), p: document.properties.p }
}

const RULE = { "x-comb-text": "no U+0000 or unpaired surrogate" }

describe("a written c.json's published schema (C4, C5)", () => {
	it("is one flat union of its schema and null when the column takes null, the rules beside it", () => {
		for (const type of ["create", "update"] as const)
			expect(published(profile('c.json("p", Profile)', type))).toEqual({
				defs: ["C4Profile"],
				p: { anyOf: [{ $ref: "#/$defs/C4Profile" }, { type: "null" }], ...RULE },
			})
	})

	it("is the bare $ref of a registered schema under a byte limit too, the limit beside it", () => {
		expect(published(profile('c.json("p", Profile, { maxBytes: 64 })', "create"))).toEqual({
			defs: ["C4Profile"],
			p: { anyOf: [{ $ref: "#/$defs/C4Profile" }, { type: "null" }], ...RULE, "x-comb-maxBytes": 64 },
		})
		expect(published(profile('c.json("p", Profile, { maxBytes: 64 }).notNull()', "create"))).toEqual({
			defs: ["C4Profile"],
			p: { anyOf: [{ $ref: "#/$defs/C4Profile" }], ...RULE, "x-comb-maxBytes": 64 },
		})
	})
})

describe("a written c.json's rules", () => {
	const capped = profile('c.json("p", Profile, { maxBytes: 20 })', "create")
	const messages = (value: unknown) => capped.safeParse(value).error?.issues.map((issue) => issue.message) ?? []

	it("take null and a value within them, and refuse what breaks either, naming each rule broken", () => {
		expect([capped.safeParse(null).success, capped.safeParse({ bio: "x" }).success]).toEqual([true, true])
		expect(messages({ bio: "x".repeat(30) })).toEqual(["JSON exceeds 20 bytes when serialized"])
		expect(messages({ bio: "\u0000" })).toEqual(["Must not contain U+0000 or an unpaired surrogate"])
		expect(messages({ bio: `\u0000${"x".repeat(30)}` })).toEqual([
			"JSON exceeds 20 bytes when serialized",
			"Must not contain U+0000 or an unpaired surrogate",
		])
		expect(messages({ bio: 1 })).not.toEqual([])
	})
})

/** The generated Postgres schema of a c.json array column of Profile written as `raw`, evaluated */
function profiles(raw: string, schemaType: SchemaType): z.ZodType {
	const field = { ...fieldOf("p", raw, { dialect: "postgres", scope: { Profile } }), jsonSchemaName: "Profile" }
	const code = generateFieldSchema(field, schemaType, {
		dialect: "postgres",
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
	}) as string
	/* the generated refine of a grid is TypeScript, typed for a consumer's noImplicitAny */
	return new Function("z", "Profile", ts.transpile(`return ${code}`))(z, Profile) as z.ZodType
}

/* C1 of r19: an array's element takes null as Postgres stores it, and the array takes null by its own column alone */
describe("a written nullable c.json array (C1)", () => {
	it.each([
		["one dimension", 'c.json("p", Profile).array()', [{ bio: "a" }, null]],
		["two dimensions", 'c.json("p", Profile).array("[][]")', [[{ bio: "a" }, null]]],
	])("takes null for the column on create and update, in %s, and publishes it beside the array", (_, raw, value) => {
		for (const type of ["create", "update"] as const) {
			const written = profiles(raw, type)
			expect([written.safeParse(null).success, written.safeParse(value).success], type).toEqual([true, true])
			const { p } = published(written)
			expect(p["anyOf"], type).toEqual([expect.objectContaining({ type: "array" }), { type: "null" }])
		}
	})

	it("refuses null for a NOT NULL array, its elements still taking null", () => {
		const written = profiles('c.json("p", Profile).array().notNull()', "create")
		expect([written.safeParse(null).success, written.safeParse([null]).success]).toEqual([false, true])
	})
})
