/**
 * The constraint types are compile-time only, so their test compiles a consumer's file against
 * them under the strictest flags a consumer might set (docs/meta-contract.md §10).
 */
import path from "node:path"
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"

const SRC = path.resolve(import.meta.dirname, "..")

function diagnostics(source: string): string[] {
	const project = new Project({
		compilerOptions: {
			allowImportingTsExtensions: true,
			exactOptionalPropertyTypes: true,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			noPropertyAccessFromIndexSignature: true,
			noUncheckedIndexedAccess: true,
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ESNext,
		},
	})
	project.createSourceFile(path.join(SRC, "__consumer__.ts"), source)
	project.resolveSourceFileDependencies()
	return project
		.getPreEmitDiagnostics()
		.filter((d) => d.getSourceFile()?.getBaseName() === "__consumer__.ts")
		.map((d) => ts.flattenDiagnosticMessageText(d.compilerObject.messageText, "\n"))
}

describe("EnumStates", () => {
	it("accepts a StateMachine under exactOptionalPropertyTypes, so one const serves c.enum and the guard (M-L5)", () => {
		const source = `import type { EnumStates } from "./sqlite/constraints.ts"
import type { StateMachine } from "./states.ts"
declare const machine: StateMachine<"open" | "done">
export const states: EnumStates<"open" | "done"> = machine
`
		expect(diagnostics(source)).toEqual([])
	})

	it("still rejects a transition from a state the machine does not declare", () => {
		const source = `import type { EnumStates } from "./sqlite/constraints.ts"
export const states: EnumStates<"open" | "done"> = { transitions: { opn: ["done"] } }
`
		expect(diagnostics(source).join("\n")).toContain("opn")
	})
})
