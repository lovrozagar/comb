import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseField } from "../../__fixtures__/runtime.ts"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"

const imports = (): ImportsMeta => ({ enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() })
const schema = (name: string, raw: string, type: SchemaType) =>
	generateFieldSchema(parseField(name, raw), type, { imports: imports() })
const array = (raw: string, type: SchemaType) =>
	generateFieldSchema(parseField("a", raw, { dialect: "postgres" }), type, { dialect: "postgres", imports: imports() })
/** A generated schema, run, its shared meta given */
const evaluate = (code: string) => new Function("z", "_m", `return ${code}`)(z, { real: {} }) as z.ZodType
/* C6 of r17: a read float's base already takes null (JSON writes ±Infinity as null), so null is published once */
describe("generateFieldSchema: a nullable read float", () => {
	const READ_FLOAT =
		'z.union([z.number(), z.literal([globalThis.Infinity, -globalThis.Infinity, null]).meta({ enum: undefined, type: "null" })])'

	it("appends no second null to a column or an array element, and parses as before", () => {
		expect(schema("r", 'c.real("r")', "read")).toBe(`${READ_FLOAT}.meta(_m.real)`)
		const nullable = evaluate(schema("r", 'c.real("r")', "read") as string)
		expect(z.toJSONSchema(nullable, { io: "output", unrepresentable: "any" })).toMatchObject({
			anyOf: [{ type: "number" }, { type: "null" }],
		})
		for (const value of [Infinity, -Infinity, null, 0.5]) expect(nullable.safeParse(value).success).toBe(true)
		expect(nullable.safeParse(Number.NaN).success).toBe(false)
		expect(array('real("a").array().notNull()', "read")).not.toContain(".nullable()")
	})
})
