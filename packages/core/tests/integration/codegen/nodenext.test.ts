/**
 * F53 of the 0.13.0 round: a consumer's TypeScript resolves the relative imports comb writes. Under
 * `node16` or `nodenext` a relative import names its file's extension, `.js` for a TypeScript file,
 * or the `.ts` itself under `allowImportingTsExtensions`; under `bundler` it may leave it out, as
 * comb always did. codegen reads the consumer's tsconfig and writes each in the form it takes.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { codegen, project, typecheck, useProjects } from "../support/codegen-project.ts"

useProjects()

const TABLES = `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
import { address } from "./schemas.js"
export const user = sqliteTable("user", { id: c.id("usr"), name: c.text("name"), address: c.json("address", address) })
export const post = sqliteTable("post", { id: c.id("pst"), authorId: c.ref("author_id").references(() => user.id) })
`
const SCHEMAS = 'import * as z from "zod"\nexport const address = z.object({ street: z.string() })\n'

/** Every relative specifier the generated files import, by file */
function relativeImports(dir: string): string[] {
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".gen.ts"))
		.flatMap((entry) =>
			[...fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8").matchAll(/from "(\.{1,2}\/[^"]*)"/g)].map(
				(match) => match[1] as string,
			),
		)
}

/* the lines of tsc's output that name a generated file: comb's own source imports `.ts` paths, which only
   a project with allowImportingTsExtensions compiles, as the README says, so it is no part of this check */
const generatedErrors = (output: string) => output.split("\n").filter((line) => line.includes(".gen.ts"))

/** A project whose tsconfig resolves as `compilerOptions` say, generated */
async function generated(compilerOptions: Record<string, unknown>): Promise<string> {
	const dir = project({
		"src/db/db.core.tables.ts": TABLES,
		"src/db/schemas.ts": SCHEMAS,
		"tsconfig.json": JSON.stringify({ compilerOptions }),
	})
	await codegen(dir, ["--tables", "src/db/db.core.tables.ts"])
	return dir
}

describe("comb codegen's relative imports, as the consumer resolves them (F53)", () => {
	const NODENEXT = { module: "nodenext", moduleResolution: "nodenext" }

	it("writes .js under nodenext, which tsc resolves there", async () => {
		const dir = await generated(NODENEXT)
		const specifiers = relativeImports(dir)
		expect(specifiers.length).toBeGreaterThan(4)
		expect(specifiers.filter((specifier) => !specifier.endsWith(".js"))).toEqual([])
		expect(generatedErrors(typecheck(dir, [], { ...NODENEXT, allowImportingTsExtensions: false }))).toEqual([])
	}, 240_000)

	it("writes .ts under nodenext with allowImportingTsExtensions, which tsc resolves there", async () => {
		const dir = await generated({ ...NODENEXT, allowImportingTsExtensions: true, noEmit: true })
		expect(relativeImports(dir).filter((specifier) => !/\.(?:ts|js)$/.test(specifier))).toEqual([])
		expect(relativeImports(dir).some((specifier) => specifier.endsWith(".gen.ts"))).toBe(true)
		expect(typecheck(dir, [], NODENEXT)).toBe("")
	}, 240_000)

	it("leaves the extension out under bundler, as before", async () => {
		const dir = await generated({ module: "preserve", moduleResolution: "bundler" })
		expect(relativeImports(dir).filter((specifier) => /\.gen\.(?:ts|js)$/.test(specifier))).toEqual([])
		expect(typecheck(dir)).toBe("")
	}, 240_000)
})
