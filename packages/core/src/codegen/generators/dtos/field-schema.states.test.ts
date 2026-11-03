import { describe, expect, it } from "vitest"
import { parseField } from "../../__fixtures__/runtime.ts"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateFieldSchema } from "./field-schema.ts"

const imports = (): ImportsMeta => ({ enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() })

/* CD4 of r22b: a state column's declared initial is the value a row starts at */
describe("a state column's create takes its initial alone (CD4; sibling: the update DTO's enum)", () => {
	const MACHINE = '["queued", "done"], { initial: "queued", terminal: ["done"] }'

	it("writes initial as a literal on create, and the enum on update and read", () => {
		const field = parseField("status", `c.enum("status", ${MACHINE}).notNull()`)
		const build = (type: SchemaType) => generateFieldSchema(field, type, { imports: imports() })
		expect(build("create")).toBe('z.literal("queued").meta({ examples: ["queued"] })')
		expect(build("update")).toBe('z.enum(["queued","done"]).meta({ examples: ["queued"] }).optional()')
		expect(build("read")).toBe('z.enum(["queued","done"]).meta({ examples: ["queued"] })')
	})

	it("keeps the enum on an array's element, which a machine of one value does not describe", () => {
		const field = parseField("steps", `c.enum("steps", ${MACHINE}).array().notNull()`, { dialect: "postgres" })
		const create = generateFieldSchema(field, "create", { dialect: "postgres", imports: imports() })
		expect(create).toContain('z.enum(["queued","done"])')
		expect(create).not.toContain("z.literal")
	})
})
