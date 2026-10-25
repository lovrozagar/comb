/**
 * The modules a tables file loads: its imports and re-exports, followed file by file and resolved
 * as the consumer's tsconfig resolves them (`paths` included). Project files are followed; a
 * package is recorded by the specifier a project file wrote, for the reader to load as that file
 * would. Type-only imports load nothing at runtime and are left out. The same walk runs under bun
 * and node, so what the reader finds by identity is the same on both.
 */
import path from "node:path"
import { ts } from "ts-morph"
import { compilerOptionsFor, isCommonJs, transpiled } from "./ts-options.mjs"

/** The literal module a `require("…")` call names, alone or under a property read; undefined for any other expression */
function required(expression: ts.Expression | undefined): string | undefined {
	const call =
		expression !== undefined && ts.isPropertyAccessExpression(expression) ? expression.expression : expression
	if (call === undefined || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) return undefined
	const [first] = call.arguments
	return call.expression.text === "require" && first !== undefined && ts.isStringLiteral(first) ? first.text : undefined
}

/**
 * The specifiers `file` loads as soon as it runs, read from the module it transpiles to, so an
 * import only types use, however written, loads nothing, as at runtime (F42a): its import and
 * re-export declarations (an `import x = require`, no ES module syntax, transpiles to nothing), and
 * in a CommonJS file the `require("…")` its top-level statements make,
 * that file's static imports. An `import()` anywhere, and a `require()` inside a function, a
 * condition or a callback, loads its module only when that code runs, so it is no import here
 * (F44): codegen loads every project file this walk finds, to find the tables and enum lists they
 * hold, and a module it loads runs. A missed edge leaves a table or a list codegen cannot name.
 */
function runtimeSpecifiers(file: string): string[] {
	const source = ts.createSourceFile(file, transpiled(file), ts.ScriptTarget.Latest, false)
	const cjs = isCommonJs(file)
	const out: string[] = []
	for (const statement of source.statements) {
		const from =
			ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) ? statement.moduleSpecifier : undefined
		if (from !== undefined && ts.isStringLiteral(from)) out.push(from.text)
		else if (cjs) {
			const expressions = ts.isExpressionStatement(statement)
				? [statement.expression]
				: ts.isVariableStatement(statement)
					? statement.declarationList.declarations.map((declaration) => declaration.initializer)
					: []
			for (const expression of expressions) {
				const module = required(expression)
				if (module !== undefined) out.push(module)
			}
		}
	}
	return out
}

/** A package a project file imports, by the specifier it wrote */
type PackageImport = { from: string; specifier: string }

/** The project files the tables file loads, itself first, and the packages they import */
type ModuleGraph = { files: string[]; packages: PackageImport[] }

/** Every module `tablesPath` loads at runtime: project files in the order the walk meets them, then packages */
function moduleGraph(tablesPath: string): ModuleGraph {
	const options = compilerOptionsFor(tablesPath)
	const files: string[] = []
	const packages: PackageImport[] = []
	const queue = [path.resolve(tablesPath)]
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (files.includes(file)) continue
		files.push(file)
		for (const specifier of runtimeSpecifiers(file)) {
			const resolved = ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule
			const local = resolved?.isExternalLibraryImport === false && !resolved.resolvedFileName.endsWith(".d.ts")
			if (local) queue.push(path.resolve((resolved as ts.ResolvedModuleFull).resolvedFileName))
			else if (!specifier.startsWith(".") && !specifier.startsWith("node:")) packages.push({ from: file, specifier })
		}
	}
	return { files, packages }
}

export { moduleGraph, runtimeSpecifiers, type ModuleGraph, type PackageImport }
