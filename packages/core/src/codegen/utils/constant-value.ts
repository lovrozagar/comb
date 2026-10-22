/**
 * The constants a table's column constraints name, read from source and never run: `pattern:
 * patterns.E164_PHONE` or `max: NAME_MAX`, followed through local consts, imports and re-exports
 * to a `const` initializer, each read at its own node. Codegen executes no user module: running one would run its side effects
 * and its own imports. A value it cannot read statically fails codegen, naming where it stands.
 */
import path from "node:path"
import { Node, type Project, type PropertyAccessExpression, type SourceFile, SyntaxKind, ts } from "ts-morph"
import type { ConstantValue } from "../analyzer-types.ts"
import { placeOf } from "./node-text.ts"

/* how many references a constant may pass through before it is called a cycle */
const MAX_DEPTH = 8

/* the module resolution a consumer's bundler applies: package exports, .ts files, self-references */
const RESOLUTION: ts.CompilerOptions = {
	allowImportingTsExtensions: true,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	noEmit: true,
}

/** Why a constant cannot be read; its message is the reason */
class Unreadable extends Error {}

/** One read: the project files are added to, and how many references it has passed through */
type Read = { depth: number; project: Project }

/** A node and the file it stands in, which its names resolve against */
type At = { file: SourceFile; node: Node }

/** What a name is bound to: a node, or a whole module, as `import * as L` and `export * as L` bind one */
type Bound = At | { module: SourceFile }

/** `bound` as a node; a module there is no value of its own */
function atOf(bound: Bound, name: string): At {
	if ("module" in bound) throw new Unreadable(`${name} is a module, not a value: name one of its exports`)
	return bound
}

/**
 * The resolution `from` resolves under: the bundler's, with the `paths` and `baseUrl` of the
 * tsconfig nearest it, so an alias the consumer's build resolves resolves here too (F22)
 */
function resolutionFor(from: SourceFile): ts.CompilerOptions {
	const config = ts.findConfigFile(path.dirname(from.getFilePath()), ts.sys.fileExists)
	if (config === undefined) return RESOLUTION
	const raw = ts.readConfigFile(config, ts.sys.readFile).config as unknown
	const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, path.dirname(config))
	/* only what the tsconfig sets: an option given as undefined is not one left out */
	const { baseUrl, paths, pathsBasePath } = parsed.options
	return {
		...RESOLUTION,
		...(baseUrl === undefined ? {} : { baseUrl }),
		...(paths === undefined ? {} : { paths, pathsBasePath }),
	}
}

/** `read` one reference further, refused past MAX_DEPTH, where a cycle would otherwise run forever */
function deeper(read: Read): Read {
	if (read.depth >= MAX_DEPTH) throw new Unreadable(`it passes through more than ${MAX_DEPTH} references`)
	return { ...read, depth: read.depth + 1 }
}

/** `node` without `as`, `satisfies`, `!`, type assertions and parentheses */
function bare(node: Node): Node {
	let at = node
	for (;;) {
		const inner =
			at.asKind(SyntaxKind.AsExpression) ??
			at.asKind(SyntaxKind.SatisfiesExpression) ??
			at.asKind(SyntaxKind.ParenthesizedExpression) ??
			at.asKind(SyntaxKind.NonNullExpression) ??
			at.asKind(SyntaxKind.TypeAssertionExpression)
		if (inner === undefined) return at
		at = inner.getExpression()
	}
}

/** The text a string literal or a no-substitution template holds, or undefined */
function textOf(node: Node | undefined): string | undefined {
	if (node === undefined) return undefined
	const literal = bare(node)
	if (Node.isStringLiteral(literal) || Node.isNoSubstitutionTemplateLiteral(literal)) return literal.getLiteralValue()
	return undefined
}

/** A regex as a literal writes it, its unescaped slashes escaped */
const regexLiteral = (source: string, flags: string) => `/${source.replace(/(?<!\\)\//g, "\\/")}/${flags}`

/** `new RegExp("…", "…")` with literal arguments, as a regex literal; undefined for anything else */
function newRegExp(node: Node): string | undefined {
	const created = node.asKind(SyntaxKind.NewExpression)
	if (created?.getExpression().getText() !== "RegExp") return undefined
	const [source, flags] = created.getArguments()
	const text = textOf(source)
	const flagText = flags === undefined ? "" : textOf(flags)
	return text === undefined || flagText === undefined ? undefined : regexLiteral(text, flagText)
}

/**
 * A numeric literal's value as runtime computes it. ts-morph's getLiteralValue parses with parseInt
 * unless the text holds a dot, so `1e-7` would read as 1 and `1e21` as 1 (F3); Number takes every
 * form a literal is written in: exponents, hex, binary, octal, a leading dot, separators.
 */
const numberOf = (node: Node): number => Number(node.getText().replaceAll("_", ""))

/** The value a literal node holds; undefined when `node` is no literal */
function literalOf(node: Node): ConstantValue | undefined {
	const text = textOf(node)
	if (text !== undefined) return text
	if (Node.isNumericLiteral(node)) return numberOf(node)
	if (node.getKind() === SyntaxKind.TrueKeyword) return true
	if (node.getKind() === SyntaxKind.FalseKeyword) return false
	if (Node.isRegularExpressionLiteral(node)) return node.getText()
	const signed = node.asKind(SyntaxKind.PrefixUnaryExpression)
	const operand = signed?.getOperand()
	if (signed !== undefined && Node.isNumericLiteral(operand)) {
		if (signed.getOperatorToken() === SyntaxKind.MinusToken) return -numberOf(operand)
		if (signed.getOperatorToken() === SyntaxKind.PlusToken) return numberOf(operand)
	}
	return newRegExp(node)
}

/** The file `specifier` names from `from`, added to the project to be read, never run */
function moduleFile(project: Project, from: SourceFile, specifier: string): SourceFile {
	const resolved = ts.resolveModuleName(specifier, from.getFilePath(), resolutionFor(from), ts.sys).resolvedModule
	if (resolved === undefined) throw new Unreadable(`its module "${specifier}" does not resolve`)
	if (/\.d\.[cm]?ts$/.test(resolved.resolvedFileName))
		throw new Unreadable(`its module "${specifier}" ships only declarations, which hold no values`)
	return project.getSourceFile(resolved.resolvedFileName) ?? project.addSourceFileAtPath(resolved.resolvedFileName)
}

/** The node a module's default export stands for: `export default <expression>`, or `export { X as default }` */
function defaultOf(read: Read, file: SourceFile): Bound {
	const assigned = file.getExportAssignment((each) => !each.isExportEquals())
	return assigned === undefined ? exportOf(read, file, "default") : { file, node: assigned.getExpression() }
}

/**
 * Where a name is bound in a file: its `const` initializer, the export of the module it imports it
 * from, that module's default export, or the module itself for `import * as`
 */
function bindingOf(read: Read, file: SourceFile, name: string): Bound {
	/* an enum: its members are read as an object's properties (F33) */
	const declared = file.getEnum(name)
	if (declared !== undefined) return { file, node: declared }
	const local = file.getVariableDeclaration(name)
	if (local !== undefined) {
		if (local.getVariableStatement()?.getDeclarationKind() !== "const") throw new Unreadable(`${name} is not a const`)
		const initializer = local.getInitializer()
		if (initializer === undefined) throw new Unreadable(`${name} has no initializer`)
		return { file, node: initializer }
	}
	for (const declaration of file.getImportDeclarations()) {
		const named = declaration
			.getNamedImports()
			.find((each) => (each.getAliasNode()?.getText() ?? each.getName()) === name)
		const whole = declaration.getNamespaceImport()?.getText() === name
		const fallback = declaration.getDefaultImport()?.getText() === name
		if (named === undefined && !whole && !fallback) continue
		const target = moduleFile(read.project, file, declaration.getModuleSpecifierValue())
		if (whole) return { module: target }
		if (fallback) return defaultOf(deeper(read), target)
		return exportOf(deeper(read), target, named?.getName() as string)
	}
	throw new Unreadable(`${name} is not a const of its file or an import of one`)
}

/** What an export of `file` named `name` stands for, through `export { … }`, re-exports and `export * as` */
function exportOf(read: Read, file: SourceFile, name: string): Bound {
	if (file.getVariableDeclaration(name)?.isExported() || file.getEnum(name)?.isExported())
		return bindingOf(read, file, name)
	for (const declaration of file.getExportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue()
		const named = declaration
			.getNamedExports()
			.find((each) => (each.getAliasNode()?.getText() ?? each.getName()) === name)
		if (named !== undefined)
			return specifier === undefined
				? bindingOf(deeper(read), file, named.getName())
				: exportOf(deeper(read), moduleFile(read.project, file, specifier), named.getName())
		/* `export * as L from`: the module itself, under that name */
		if (specifier !== undefined && declaration.getNamespaceExport()?.getName() === name)
			return { module: moduleFile(read.project, file, specifier) }
		const star =
			specifier !== undefined && declaration.getNamedExports().length === 0 && !declaration.getNamespaceExport()
		/* `export * from`: the name is the target's export, if it has one */
		const found = star ? tryExportOf(deeper(read), moduleFile(read.project, file, specifier), name) : undefined
		if (found !== undefined) return found
	}
	throw new Unreadable(`${file.getBaseName()} exports no ${name}`)
}

/** exportOf, or undefined when `file` does not export the name (an `export *` target it is not in) */
function tryExportOf(read: Read, file: SourceFile, name: string): Bound | undefined {
	try {
		return exportOf(read, file, name)
	} catch (error) {
		// reason: an `export *` target without the name is not where it lives; the next one may be
		if (error instanceof Unreadable && error.message === `${file.getBaseName()} exports no ${name}`) return undefined
		throw error
	}
}

/** The object literal `at` stands for, or the module a namespace binding names */
function objectOf(read: Read, at: Bound): Bound {
	if ("module" in at) return at
	const node = bare(at.node)
	if (Node.isObjectLiteralExpression(node) || Node.isEnumDeclaration(node)) return { file: at.file, node }
	if (Node.isIdentifier(node)) return objectOf(deeper(read), bindingOf(deeper(read), at.file, node.getText()))
	throw new Unreadable(`${node.getText()} is not an object literal`)
}

/* the constants of Number that are finite numbers, which a bound may name (F33) */
// lookup-table: Number's finite constants by name
const NUMBER_CONSTANTS: ReadonlyMap<string, number> = /* @__PURE__ */ new Map([
	["EPSILON", Number.EPSILON],
	["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
	["MAX_VALUE", Number.MAX_VALUE],
	["MIN_SAFE_INTEGER", Number.MIN_SAFE_INTEGER],
	["MIN_VALUE", Number.MIN_VALUE],
])

/** `Number.MAX_SAFE_INTEGER` and its kind, when `access` is one and the file binds no Number of its own */
function numberConstantOf(file: SourceFile, access: Node): number | undefined {
	const property = access.asKind(SyntaxKind.PropertyAccessExpression)
	if (property?.getExpression().getText() !== "Number" || file.getVariableDeclaration("Number") !== undefined)
		return undefined
	const value = NUMBER_CONSTANTS.get(property.getName())
	if (value === undefined) throw new Unreadable(`${property.getText()} is not a constant comb reads`)
	return value
}

/** The value `at` stands for, following references to a literal */
function valueOf(read: Read, at: At): ConstantValue {
	const node = bare(at.node)
	const literal = literalOf(node)
	if (literal !== undefined) return literal
	if (Node.isIdentifier(node))
		return valueOf(deeper(read), atOf(bindingOf(deeper(read), at.file, node.getText()), node.getText()))
	const access = node.asKind(SyntaxKind.PropertyAccessExpression)
	if (access === undefined) throw new Unreadable(`${node.getText()} is computed, not a literal`)
	const numberConstant = numberConstantOf(at.file, access)
	if (numberConstant !== undefined) return numberConstant
	const owner = objectOf(deeper(read), { file: at.file, node: access.getExpression() })
	return valueOf(deeper(read), memberOf(read, owner, access))
}

/** The node `owner.<name>` stands for: a namespace's export, an enum member's initializer, or an object's property */
function memberOf(read: Read, owner: Bound, access: PropertyAccessExpression): At {
	/* `L.MAX` of a namespace: the module's export named MAX */
	if ("module" in owner) return atOf(exportOf(deeper(read), owner.module, access.getName()), access.getText())
	if (owner.node.isKind(SyntaxKind.EnumDeclaration)) {
		const initializer = owner.node.getMember(access.getName())?.getInitializer()
		if (initializer === undefined) throw new Unreadable(`${access.getText()} has no literal initializer`)
		return { file: owner.file, node: initializer }
	}
	const property = owner.node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperty(access.getName())
	/* `{ SLUG }` is `{ SLUG: SLUG }`: the name, bound in the object's file */
	const value =
		property?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer() ??
		property?.asKind(SyntaxKind.ShorthandPropertyAssignment)?.getNameNode()
	if (value === undefined) throw new Unreadable(`its object has no plain property ${access.getName()}`)
	return { file: owner.file, node: value }
}

/**
 * The value `node` stands for, read at that node: a literal, or a reference followed through
 * consts, imports and re-exports to one; an error naming its file, line and expression otherwise
 */
export function readValue(project: Project, node: Node): ConstantValue {
	try {
		return valueOf({ depth: 0, project }, { file: node.getSourceFile(), node })
	} catch (error) {
		/* every failure names where the value stands; the original is kept as the cause */
		throw new Error(
			`${placeOf(node)}: comb cannot read ${node.getText()}: ${(error as Error).message}; write it as a literal, or a const of literals`,
			{ cause: error },
		)
	}
}
