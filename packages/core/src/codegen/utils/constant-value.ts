/**
 * The constants a table's column constraints name, read from source and never run: `pattern:
 * patterns.E164_PHONE` or `max: NAME_MAX`, followed through local consts, imports and re-exports
 * to a `const` initializer. Codegen executes no user module: running one would run its side effects
 * and its own imports. A value it cannot read statically fails codegen, naming where it stands.
 */
import { Node, type Project, type SourceFile, SyntaxKind, ts } from "ts-morph"
import type { ConstantValue } from "../analyzer-types.ts"
import { placeOf } from "./node-text.ts"
import { tableSourceFiles } from "./ts-morph.ts"

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

/** The value a literal node holds; undefined when `node` is no literal */
function literalOf(node: Node): ConstantValue | undefined {
	const text = textOf(node)
	if (text !== undefined) return text
	if (Node.isNumericLiteral(node)) return node.getLiteralValue()
	if (node.getKind() === SyntaxKind.TrueKeyword) return true
	if (node.getKind() === SyntaxKind.FalseKeyword) return false
	if (Node.isRegularExpressionLiteral(node)) return node.getText()
	const negative = node.asKind(SyntaxKind.PrefixUnaryExpression)
	const operand = negative?.getOperand()
	if (negative?.getOperatorToken() === SyntaxKind.MinusToken && Node.isNumericLiteral(operand))
		return -operand.getLiteralValue()
	return newRegExp(node)
}

/** The file `specifier` names from `from`, added to the project to be read, never run */
function moduleFile(project: Project, from: SourceFile, specifier: string): SourceFile {
	const resolved = ts.resolveModuleName(specifier, from.getFilePath(), RESOLUTION, ts.sys).resolvedModule
	if (resolved === undefined) throw new Unreadable(`its module "${specifier}" does not resolve`)
	if (/\.d\.[cm]?ts$/.test(resolved.resolvedFileName))
		throw new Unreadable(`its module "${specifier}" ships only declarations, which hold no values`)
	return project.getSourceFile(resolved.resolvedFileName) ?? project.addSourceFileAtPath(resolved.resolvedFileName)
}

/** Where a name is bound in a file: its `const` initializer, or the export of the module it imports it from */
function bindingOf(read: Read, file: SourceFile, name: string): At {
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
		if (named === undefined) continue
		const target = moduleFile(read.project, file, declaration.getModuleSpecifierValue())
		return exportOf(deeper(read), target, named.getName())
	}
	throw new Unreadable(`${name} is not a const of its file or an import of one`)
}

/** The node an export of `file` named `name` stands for, through `export { … }` and re-exports */
function exportOf(read: Read, file: SourceFile, name: string): At {
	if (file.getVariableDeclaration(name)?.isExported()) return bindingOf(read, file, name)
	for (const declaration of file.getExportDeclarations()) {
		const specifier = declaration.getModuleSpecifierValue()
		const named = declaration
			.getNamedExports()
			.find((each) => (each.getAliasNode()?.getText() ?? each.getName()) === name)
		if (named !== undefined)
			return specifier === undefined
				? bindingOf(deeper(read), file, named.getName())
				: exportOf(deeper(read), moduleFile(read.project, file, specifier), named.getName())
		const star =
			specifier !== undefined && declaration.getNamedExports().length === 0 && !declaration.getNamespaceExport()
		/* `export * from`: the name is the target's export, if it has one */
		const found = star ? tryExportOf(deeper(read), moduleFile(read.project, file, specifier), name) : undefined
		if (found !== undefined) return found
	}
	throw new Unreadable(`${file.getBaseName()} exports no ${name}`)
}

/** exportOf, or undefined when `file` does not export the name (an `export *` target it is not in) */
function tryExportOf(read: Read, file: SourceFile, name: string): At | undefined {
	try {
		return exportOf(read, file, name)
	} catch (error) {
		// reason: an `export *` target without the name is not where it lives; the next one may be
		if (error instanceof Unreadable && error.message === `${file.getBaseName()} exports no ${name}`) return undefined
		throw error
	}
}

/** The object literal `at` stands for */
function objectOf(read: Read, at: At): At {
	const node = bare(at.node)
	if (Node.isObjectLiteralExpression(node)) return { file: at.file, node }
	if (Node.isIdentifier(node)) return objectOf(deeper(read), bindingOf(deeper(read), at.file, node.getText()))
	throw new Unreadable(`${node.getText()} is not an object literal`)
}

/** The value `at` stands for, following references to a literal */
function valueOf(read: Read, at: At): ConstantValue {
	const node = bare(at.node)
	const literal = literalOf(node)
	if (literal !== undefined) return literal
	if (Node.isIdentifier(node)) return valueOf(deeper(read), bindingOf(deeper(read), at.file, node.getText()))
	const access = node.asKind(SyntaxKind.PropertyAccessExpression)
	if (access === undefined) throw new Unreadable(`${node.getText()} is computed, not a literal`)
	const owner = objectOf(deeper(read), { file: at.file, node: access.getExpression() })
	const property = owner.node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperty(access.getName())
	/* `{ SLUG }` is `{ SLUG: SLUG }`: the name, bound in the object's file */
	const value =
		property?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer() ??
		property?.asKind(SyntaxKind.ShorthandPropertyAssignment)?.getNameNode()
	if (value === undefined) throw new Unreadable(`its object has no plain property ${access.getName()}`)
	return valueOf(deeper(read), { file: owner.file, node: value })
}

/**
 * The constraint values of a table file that name a constant: the identifier and `identifier.PROPERTY`
 * values of each `c.<helper>(…)` call's object arguments, c.enum's state machine aside
 */
function constantReferences(file: SourceFile): Node[] {
	return file
		.getDescendantsOfKind(SyntaxKind.CallExpression)
		.filter((call) => /^c\.\w+$/.test(call.getExpression().getText()) && call.getExpression().getText() !== "c.enum")
		.flatMap((call) => call.getArguments().map(bare))
		.flatMap((arg) => arg.asKind(SyntaxKind.ObjectLiteralExpression)?.getProperties() ?? [])
		.flatMap((property) => property.asKind(SyntaxKind.PropertyAssignment)?.getInitializer() ?? [])
		.filter((value) => Node.isIdentifier(bare(value)) || Node.isPropertyAccessExpression(bare(value)))
}

/** The value `reference` (in `file`) names, or an error naming its file, line and expression */
function readConstant(project: Project, file: SourceFile, reference: Node): ConstantValue {
	try {
		return valueOf({ depth: 0, project }, { file, node: reference })
	} catch (error) {
		/* every failure names where the constant stands; the original is kept as the cause */
		throw new Error(
			`${placeOf(reference)}: comb cannot read the constant ${reference.getText()}: ${(error as Error).message}; write it as a literal, or a const of literals`,
			{ cause: error },
		)
	}
}

/**
 * Every constant the tables' constraints name, by the text that names it (`patterns.E164_PHONE`),
 * read statically; throws, naming the file, line and expression, for one it cannot read
 */
export function constraintConstants(project: Project, tablesPath: string): Map<string, ConstantValue> {
	const out = new Map<string, ConstantValue>()
	for (const file of tableSourceFiles(project, tablesPath)) {
		for (const reference of constantReferences(file)) {
			if (!out.has(reference.getText())) out.set(reference.getText(), readConstant(project, file, reference))
		}
	}
	return out
}
