/**
 * The modules a tables file loads: its imports and re-exports, followed file by file and resolved
 * as the consumer's tsconfig resolves them (`paths` included). Project files are followed; a
 * package is recorded by the specifier a project file wrote, for the reader to load as that file
 * would. Type-only imports load nothing at runtime and are left out. The same walk runs under bun
 * and node, so what the reader finds by identity is the same on both.
 */
import path from "node:path"
import { ts } from "ts-morph"
import { compilerOptionsFor, transpiled } from "./ts-options.mjs"

/**
 * The specifiers `file` loads at runtime: the imports and re-exports of the module it transpiles
 * to, so an import only types use, however written, loads nothing, as at runtime (F42a)
 */
function runtimeSpecifiers(file: string): string[] {
	return ts.preProcessFile(transpiled(file), true, false).importedFiles.map(({ fileName }) => fileName)
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
