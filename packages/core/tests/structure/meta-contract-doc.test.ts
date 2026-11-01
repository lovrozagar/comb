/**
 * C9 of r18: docs/meta-contract.md drifts from the code it names. Each claim a reader would check
 * against the source is held to it here: §3's producers live where the table says, §6 reads in
 * order, and §8.2 names each filter the manifest projects the stamp through.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const CORE = join(import.meta.dirname, "../..")
const DOC = readFileSync(join(CORE, "docs/meta-contract.md"), "utf8")

/** The text of the section whose heading starts with `heading`, up to the next heading of its level or above */
function section(heading: string): string {
	const start = DOC.indexOf(`\n${heading}`)
	const level = (heading.match(/^#+/) as RegExpMatchArray)[0].length
	const next = DOC.slice(start + 1).search(new RegExp(`\\n#{1,${level}} `))
	return next === -1 ? DOC.slice(start) : DOC.slice(start, start + 1 + next)
}

describe("docs/meta-contract.md against the code", () => {
	it("names, for each producer in §3, the file that defines it", () => {
		const rows = [...section("## 3. Producer API").matchAll(/^\| `(\w+)` \(`([^`]+)`\)/gm)]
		expect(rows.length).toBeGreaterThan(1)
		for (const [, producer, file] of rows) {
			const source = readFileSync(join(CORE, "src", file as string), "utf8")
			expect(source, `${producer} in ${file}`).toMatch(new RegExp(`(?:function|const) ${producer}\\b`))
		}
	})

	it("numbers §6's subsections in the order they stand", () => {
		const numbers = [...section("## 6.").matchAll(/^### 6\.(\d+) /gm)].map(([, n]) => Number(n))
		expect(numbers).toEqual(numbers.toSorted((a, b) => a - b))
		expect(numbers).toEqual(numbers.map((_, i) => i + 1))
	})

	it("names in §8.2 every filter of the stamp the manifest projects through", () => {
		const manifest = readFileSync(join(CORE, "src/codegen/generators/manifest.ts"), "utf8")
		const filters = [...new Set(manifest.match(/\bpublished\w+/g))]
		expect(filters.length).toBeGreaterThan(0)
		for (const filter of filters) expect(section("## 8.2"), filter).toContain(`\`${filter}\``)
	})
})
