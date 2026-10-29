/**
 * C9 of r17: meta-contract §8's worked example is what codegen generates for its table, read from
 * the generated file, so it cannot drift from the generator again.
 */
import fs from "node:fs"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { cleanGeneratedDtos, generatedDir, generatedDtos } from "../support/dtos.ts"

const DOC = path.join(import.meta.dirname, "../../../docs/meta-contract.md")

/** The `ts` code block that follows `heading` in the doc */
function blockAfter(doc: string, heading: string): string {
	const at = doc.indexOf(heading)
	const open = doc.indexOf("```ts\n", at) + "```ts\n".length
	return doc.slice(open, doc.indexOf("\n```", open))
}

/** Code as tokens: the doc's formatter wraps it its own way, with trailing commas */
const tokens = (code: string) => code.replace(/\s+/g, "").replace(/,([)}\]])/g, "$1")

afterAll(() => cleanGeneratedDtos())

describe("meta-contract §8, the worked example (C9)", () => {
	it("shows, as step 2, the read schema codegen generates for step 1's table", async () => {
		const doc = fs.readFileSync(DOC, "utf8")
		const table = blockAfter(doc, "**1 — comb table definition**")
		await generatedDtos("meta-contract", table)
		const generated = fs.readFileSync(path.join(generatedDir("meta-contract"), "dtos/post/index.gen.ts"), "utf8")
		const start = generated.indexOf("export const postDtoReadSchema")
		const read = generated.slice(start, generated.indexOf("\n\n", start))
		expect(tokens(blockAfter(doc, "**2 — generated DTO, stamped by `generateDtos`**"))).toBe(tokens(read))
	})
})
