/**
 * C9 and K4 of r19: meta-contract §2.1 defines each `x-comb-transform` value exactly, as a reader in
 * any language needs, and these hold the definitions to what codegen emits and zod does: the names
 * to the list codegen can emit, the trim set to ECMAScript's over all of Unicode, and the fixtures
 * consumers test against to the operations themselves.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { parseField } from "../../src/codegen/__fixtures__/runtime.ts"
import { SHARED_META_KEYS, SHARED_META_VALUES } from "../../src/codegen/generators/dtos/example-meta.ts"
import { generateFieldSchema } from "../../src/codegen/generators/dtos/field-schema.ts"
import { TRANSFORMS } from "../../src/codegen/generators/dtos/text-schema.ts"
import { passwordText } from "../../src/password-text.ts"
import { isStorableText } from "../../src/storable-text.ts"

const CONTRACT = readFileSync(join(import.meta.dirname, "../../docs/meta-contract.md"), "utf8")
const FIELD_KEYS = CONTRACT.slice(CONTRACT.indexOf("### 2.1 Field keys"), CONTRACT.indexOf("## 3. Producer API"))

/* codegen's transforms, and the one passwordText publishes (C2 of r22) */
const EMITTED: string[] = [...TRANSFORMS, ...(z.toJSONSchema(passwordText())["x-comb-transform"] as string[])]

/** The code points §2.1's trim definition lists, ranges unfolded */
function listedTrim(): number[] {
	const line = /`"trim"`:[^\n]*(?:\n {4}[^\n]*)*/.exec(FIELD_KEYS)?.[0] ?? ""
	return [...line.matchAll(/U\+([0-9A-F]{4})(?:–U\+([0-9A-F]{4}))?/g)].flatMap(([, from, to]) => {
		const start = Number.parseInt(from as string, 16)
		const end = to === undefined ? start : Number.parseInt(to, 16)
		return Array.from({ length: end - start + 1 }, (_, i) => start + i)
	})
}

/** The surrogate code points aside, each code point `String.prototype.trim` removes */
function trimmedByEcmaScript(): number[] {
	const trimmed: number[] = []
	for (let point = 0; point <= 0x10ffff; point++)
		if ((point < 0xd800 || point > 0xdfff) && String.fromCodePoint(point).trim() === "") trimmed.push(point)
	return trimmed
}

describe("meta-contract §2.1's transforms", () => {
	it("defines every transform comb can emit, codegen's and passwordText's nfc, and no other", () => {
		const defined = [...FIELD_KEYS.matchAll(/^ {2}- `"([\w-]+)"`:/gm)].map(([, name]) => name)
		expect(defined.toSorted()).toEqual(EMITTED.toSorted())
	})

	it("lists exactly the code points ECMAScript's trim removes, all 25, U+FEFF in and U+0085 out", () => {
		const listed = listedTrim()
		expect(listed).toEqual(trimmedByEcmaScript())
		expect(listed).toHaveLength(25)
		expect(listed).toContain(0xfeff)
		expect(listed).not.toContain(0x85)
	})

	it("gives fixtures each operation produces, for a consumer's tests", () => {
		const block = /```json\n\s*(\[[\s\S]*?\])\n\s*```/.exec(FIELD_KEYS)?.[1] as string
		const fixtures = JSON.parse(block) as Array<{ expect: string; input: string; transform: string }>
		const operations: Record<string, (value: string) => string> = {
			lowercase: (value) => value.toLowerCase(),
			nfc: (value) => value.normalize("NFC"),
			"strip-tab-newline": (value) => value.replace(/[\t\n\r]/g, ""),
			trim: (value) => value.trim(),
			uppercase: (value) => value.toUpperCase(),
		}
		expect(fixtures.length).toBeGreaterThan(0)
		for (const { expect: want, input, transform } of fixtures)
			expect(operations[transform]?.(input), `${transform} ${JSON.stringify(input)}`).toBe(want)
		expect(new Set(fixtures.map(({ transform }) => transform))).toEqual(new Set(EMITTED))
	})
})

/* the shared file's example meta, as the generated module imports it */
const META = new Function(`return {${SHARED_META_KEYS.map((key) => `${key}: ${SHARED_META_VALUES[key]}`).join(",")}}`)()

/** The property codegen publishes for the nullable create field `raw` */
function publishedProperty(raw: string): unknown {
	const code = generateFieldSchema(parseField("t", raw), "create", {
		imports: { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() },
	}) as string
	const field = new Function("z", "comb", "_m", ts.transpile(`return ${code}`))(
		z,
		{ isStorableText },
		META,
	) as z.ZodType
	const document = z.toJSONSchema(z.object({ t: field }), { io: "input" }) as unknown as {
		properties: { t: unknown }
	}
	return document.properties.t
}

const xComb = (schema: Record<string, unknown>) => Object.keys(schema).filter((key) => key.startsWith("x-comb-"))

/* C1 of r20: a nullable field's keys sit on the property and on its non-null member alike */
describe("meta-contract §2.1's placement", () => {
	it("shows a nullable field's property as codegen publishes it, the keys at both levels", () => {
		const blocks = [...FIELD_KEYS.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, body]) => JSON.parse(body as string))
		const shown = blocks.find((block) => !Array.isArray(block)) as { anyOf: Array<Record<string, unknown>> }
		expect(shown, "§2.1 shows a nullable property").toBeDefined()
		expect(shown).toEqual(publishedProperty('c.text("t", { max: 9, trim: true })'))
		expect(xComb(shown.anyOf[0] as Record<string, unknown>)).toEqual(xComb(shown as never))
	})
})
