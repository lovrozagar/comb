/**
 * comb.config.ts written through defineCodegenConfig: a valid config compiles, and a mistyped
 * generator, output key or driver is a compile error rather than a run that ignores it.
 */
import path from "node:path"
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"

const CODEGEN = import.meta.dirname

function diagnostics(source: string): string[] {
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
	project.createSourceFile(path.join(CODEGEN, "__consumer__.ts"), source)
	project.resolveSourceFileDependencies()
	return project
		.getPreEmitDiagnostics()
		.filter((d) => d.getSourceFile()?.getBaseName() === "__consumer__.ts")
		.map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n"))
}

const config = (core: string) => `import { defineCodegenConfig } from "./index.ts"
export default defineCodegenConfig({ databases: { core: { tables: "./src/db/core.tables.ts", ${core} } } })
`

describe("defineCodegenConfig (A-Low)", () => {
	it("accepts the README's config", () => {
		const core = `dialect: "sqlite", driver: "d1", filePrefix: "db.core", generators: ["dtos", "orm"], output: { default: "./src/db/_gen", dtos: "./src/dtos" }, fts: { post: { columns: ["title"], tokenizer: "porter unicode61" } }`
		expect(diagnostics(config(core))).toEqual([])
	})

	it.each([
		['generators: ["dto"]', "dto"],
		['output: { dto: "./x" }', "dto"],
		['driver: "postgres-js"', "postgres-js"],
	])("refuses %s", (core, word) => {
		expect(diagnostics(config(core)).join("\n")).toContain(word)
	})
})
