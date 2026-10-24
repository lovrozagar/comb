/**
 * The compiler options a consumer's tsconfig gives a file, which the module graph and the node
 * hooks resolve with, and the module a TypeScript file transpiles to under them: what the node
 * hook loads, and what the module graph reads a file's runtime imports from. Plain JavaScript:
 * node loads the hooks before it can load TypeScript.
 */
import fs from "node:fs"
import path from "node:path"
import { ts } from "ts-morph"

/**
 * The compiler options of the tsconfig nearest `from`, over the bundler resolution comb reads
 * TypeScript files with; those defaults alone when there is no tsconfig
 * @param {string} from
 * @returns {import("ts-morph").ts.CompilerOptions}
 */
export function compilerOptionsFor(from) {
	const base = { allowImportingTsExtensions: true, moduleResolution: ts.ModuleResolutionKind.Bundler }
	const config = ts.findConfigFile(path.dirname(from), (file) => ts.sys.fileExists(file))
	if (config === undefined) return base
	const host = {
		...ts.sys,
		/** @param {import("ts-morph").ts.Diagnostic} diagnostic */
		onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
			throw new Error(`${config}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`)
		},
	}
	/* the host throws on a config it cannot read, so a parse always comes back */
	const parsed = /** @type {import("ts-morph").ts.ParsedCommandLine} */ (
		ts.getParsedCommandLineOfConfigFile(config, {}, host)
	)
	return { ...base, ...parsed.options }
}

/**
 * The ES module `fileName` transpiles to under its tsconfig: imports only types use elided, and
 * every import kept under verbatimModuleSyntax, as bun and the node hook run it
 * @param {string} fileName
 * @returns {string}
 */
export function transpiled(fileName) {
	const compilerOptions = {
		...compilerOptionsFor(fileName),
		module: ts.ModuleKind.ESNext,
		/* the hook loads a .ts specifier as written */
		rewriteRelativeImportExtensions: false,
		target: ts.ScriptTarget.ES2022,
	}
	return ts.transpileModule(fs.readFileSync(fileName, "utf8"), { compilerOptions, fileName }).outputText
}
