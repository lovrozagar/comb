/**
 * F6 of the 0.14.1 review: the README's "First schema" runs as written. Its tables file and its
 * comb.config.ts are taken from the README's own blocks, by the path each names on its first line,
 * and codegen runs over them, as a reader following the README would.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { codegen, project, typecheck, useProjects } from "../support/codegen-project.ts"

useProjects()

const README = fs.readFileSync(path.join(import.meta.dirname, "../../../../../README.md"), "utf8")

/** The README's ```ts block whose first line names `file`, as a reader would copy it */
function block(file: string): string {
	const found = [...README.matchAll(/```ts\n([\s\S]*?)\n```/g)]
		.map((match) => match[1] as string)
		.find((code) => code.startsWith(`/* ${file} */`))
	if (found === undefined) throw new Error(`README has no block for ${file}`)
	return `${found}\n`
}

describe("README: First schema", () => {
	it("generates from the tables and config the README shows, and the result compiles", async () => {
		const dir = project({
			"comb.config.ts": block("comb.config.ts"),
			"src/db/core.tables.ts": block("src/db/core.tables.ts"),
		})
		await codegen(dir)
		expect(fs.existsSync(path.join(dir, "src/db/_gen"))).toBe(true)
		typecheck(dir)
	}, 120_000)
})
