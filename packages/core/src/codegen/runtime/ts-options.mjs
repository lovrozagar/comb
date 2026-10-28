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
 * The compiler options the tsconfig nearest `from` sets, as the consumer wrote them; none when
 * there is no tsconfig. What the consumer's TypeScript takes of comb's output is read from these
 * (F53), never from the defaults comb reads files with
 * @param {string} from
 * @returns {import("ts-morph").ts.CompilerOptions}
 */
export function tsconfigOptions(from) {
	const config = ts.findConfigFile(path.dirname(from), (file) => ts.sys.fileExists(file))
	if (config === undefined) return {}
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
	return parsed.options
}

/**
 * The compiler options of the tsconfig nearest `from`, over the bundler resolution comb reads
 * TypeScript files with; those defaults alone when there is no tsconfig
 * @param {string} from
 * @returns {import("ts-morph").ts.CompilerOptions}
 */
export function compilerOptionsFor(from) {
	return {
		allowImportingTsExtensions: true,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		...tsconfigOptions(from),
	}
}

/**
 * The "type" the nearest package.json of `file` names, undefined for none or no package.json
 * @param {string} file
 * @returns {unknown}
 */
function packageType(file) {
	for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
		const manifest = path.join(dir, "package.json")
		if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, "utf8")).type
		if (path.dirname(dir) === dir) return undefined
	}
}

/**
 * Whether `file` may run as CommonJS: a .cjs or .cts file, or one whose nearest package.json names
 * no "type": "module"
 * @param {string} file
 * @returns {boolean}
 */
/* mirrors bun, which runs a top-level require even beside imports: the module walk reads requires by it */
export function isCommonJs(file) {
	if (/\.c[jt]s$/.test(file)) return true
	if (/\.m[jt]s$/.test(file)) return false
	return packageType(file) !== "module"
}

/**
 * Whether a statement exports at runtime: an export modifier on anything but a type, an interface
 * or an ambient declaration
 * @param {import("ts-morph").ts.Statement} statement
 * @returns {boolean}
 */
function exportsValue(statement) {
	if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return false
	const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
	const has = (/** @type {import("ts-morph").ts.SyntaxKind} */ kind) => modifiers.some((each) => each.kind === kind)
	return has(ts.SyntaxKind.ExportKeyword) && !has(ts.SyntaxKind.DeclareKeyword)
}

/**
 * Whether a top-level statement is module syntax once types are stripped: an import or export of
 * values, `export default`, or an exported declaration
 * @param {import("ts-morph").ts.Statement} statement
 * @returns {boolean}
 */
function moduleStatement(statement) {
	if (ts.isImportDeclaration(statement)) return statement.importClause?.isTypeOnly !== true
	if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly
	if (ts.isExportAssignment(statement)) return statement.isExportEquals !== true
	return exportsValue(statement)
}

/**
 * Whether `source` has the module syntax node detects in a file of a package with no "type": a
 * value import or export, import.meta, or a top-level await
 * @param {string} fileName
 * @param {string} source
 * @returns {boolean}
 */
function hasModuleSyntax(fileName, source) {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
	if (file.statements.some(moduleStatement)) return true
	/** @param {import("ts-morph").ts.Node} node @returns {boolean} */
	const found = (node) => {
		if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) return true
		if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) return true
		/* an await in a function is that function's */
		if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node)) return hasImportMeta(node)
		return ts.forEachChild(node, found) === true
	}
	/** @param {import("ts-morph").ts.Node} node @returns {boolean} */
	const hasImportMeta = (node) =>
		(ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) ||
		ts.forEachChild(node, hasImportMeta) === true
	return ts.forEachChild(file, found) === true
}

/**
 * Whether node runs `file` as CommonJS, as it decides under type stripping: a .cjs or .cts file, one
 * of a package whose type is "commonjs", or one of a package with no type that has no module syntax
 * (F54); `source` is the file's text
 * @param {string} file
 * @param {string} source
 * @returns {boolean}
 */
/* mirrors node (22.7 and later, comb's floor 22.12), which detects module syntax: the node hook's format */
export function runsAsCommonJs(file, source) {
	if (/\.c[jt]s$/.test(file)) return true
	if (/\.m[jt]s$/.test(file)) return false
	const type = packageType(file)
	if (type === "module") return false
	return type === "commonjs" || !hasModuleSyntax(file, source)
}

/**
 * The module `fileName` transpiles to under its tsconfig, an ES module unless `module` says
 * otherwise: imports only types use elided, and every import kept under verbatimModuleSyntax, as
 * bun and the node hook run it
 * @param {string} fileName
 * @param {import("ts-morph").ts.ModuleKind} [module]
 * @returns {string}
 */
export function transpiled(fileName, module = ts.ModuleKind.ESNext) {
	const compilerOptions = {
		...compilerOptionsFor(fileName),
		module,
		/* the hook loads a .ts specifier as written */
		rewriteRelativeImportExtensions: false,
		target: ts.ScriptTarget.ES2022,
	}
	return ts.transpileModule(fs.readFileSync(fileName, "utf8"), { compilerOptions, fileName }).outputText
}
