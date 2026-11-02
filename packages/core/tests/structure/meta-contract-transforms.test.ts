/**
 * C9 and K4 of r19: meta-contract §2.1 defines each `x-comb-transform` value exactly, as a reader in
 * any language needs, and these hold the definitions to what codegen emits and zod does: the names
 * to the list codegen can emit, the trim set to ECMAScript's over all of Unicode, and the fixtures
 * consumers test against to the operations themselves.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TRANSFORMS } from "../../src/codegen/generators/dtos/text-schema.ts"

const CONTRACT = readFileSync(join(import.meta.dirname, "../../docs/meta-contract.md"), "utf8")
const FIELD_KEYS = CONTRACT.slice(CONTRACT.indexOf("### 2.1 Field keys"), CONTRACT.indexOf("## 3. Producer API"))

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
	it("defines every transform codegen can emit, and no other", () => {
		const defined = [...FIELD_KEYS.matchAll(/^ {2}- `"(\w+)"`:/gm)].map(([, name]) => name)
		expect(defined.toSorted()).toEqual([...TRANSFORMS].toSorted())
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
			trim: (value) => value.trim(),
			uppercase: (value) => value.toUpperCase(),
		}
		expect(fixtures.length).toBeGreaterThan(0)
		for (const { expect: want, input, transform } of fixtures)
			expect(operations[transform]?.(input), `${transform} ${JSON.stringify(input)}`).toBe(want)
		expect(new Set(fixtures.map(({ transform }) => transform))).toEqual(new Set(TRANSFORMS))
	})
})
