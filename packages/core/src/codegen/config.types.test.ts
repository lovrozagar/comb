/**
 * comb.config.ts written through defineCodegenConfig: a valid config compiles, and a mistyped
 * generator, output key or driver is a compile error rather than a run that ignores it.
 */
import path from "node:path"
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"

const CODEGEN = import.meta.dirname

/* one program for every case: building it is the slow part of a compile test */
const project = new Project({
	compilerOptions: {
		allowImportingTsExtensions: true,
		exactOptionalPropertyTypes: true,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: ts.ScriptTarget.ESNext,
	},
})
let cases = 0

/** The compiler's messages for `source` as a consumer file beside the codegen modules */
function diagnostics(source: string): string[] {
	const file = project.createSourceFile(path.join(CODEGEN, `__consumer_${cases++}__.ts`), source)
	project.resolveSourceFileDependencies()
	const messages = file
		.getPreEmitDiagnostics()
		.map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n"))
	project.removeSourceFile(file)
	return messages
}

/* a compile test builds a TypeScript program; under a full parallel run that takes seconds */
const COMPILE_TIMEOUT_MS = 60_000

const config = (core: string) => `import { defineCodegenConfig } from "./index.ts"
export default defineCodegenConfig({ databases: { core: { tables: "./src/db/core.tables.ts", ${core} } } })
`

describe("defineCodegenConfig (A-Low)", () => {
	it(
		"accepts the README's config",
		() => {
			const core = `dialect: "sqlite", driver: "d1", filePrefix: "db.core", generators: ["dtos", "orm"], output: { default: "./src/db/_gen", dtos: "./src/dtos" }, fts: { post: { columns: ["title"], tokenizer: "porter unicode61" } }`
			expect(diagnostics(config(core))).toEqual([])
		},
		COMPILE_TIMEOUT_MS,
	)

	it.each([
		['generators: ["dto"]', "dto"],
		['output: { dto: "./x" }', "dto"],
		['driver: "postgres-js"', "postgres-js"],
	])(
		"refuses %s",
		(core, word) => {
			expect(diagnostics(config(core)).join("\n")).toContain(word)
		},
		COMPILE_TIMEOUT_MS,
	)
})
