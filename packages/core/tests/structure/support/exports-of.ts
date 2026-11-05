/**
 * Every name each export subpath of a package exports, values and types alike, sorted, each with a
 * hash of what a consumer's compiler reads for it: its declaration, and the declaration of every
 * comb-local type it names, followed through those (KT3 of r22b), exported or not, so a type that
 * only becomes exported changes no hash. The hashes read the declarations, a tree's as
 * tsconfig.strict.json emits them and a release's as its tarball ships them, printed without
 * comments, layout, `export` or `declare`: a hash changes when a consumer's compiler would see a
 * change, and only then. Beside them, the members of every type an export reaches, its own type or
 * one it names, each optional or required, by the type's name: what a removed member or one that
 * became required is read from, which no hash names.
 */
import { createHash } from "node:crypto"
import { ts } from "ts-morph"
import {
	checkerOf,
	type Declarations,
	exportsBySubpath,
	MEMBER,
	named,
	packedDeclarations,
	real,
	withEmitted,
} from "./declarations.ts"

export { type ExportTarget, sourceOf } from "./declarations.ts"

export type Exports = Record<string, Record<string, string>>

/** Each type an export reaches, by name, with its members, each `optional` or `required` */
export type Members = Record<string, Record<string, "optional" | "required">>

/** A package's exports with their hashes, and the members of the types they reach */
export type Api = { exports: Exports; members: Members }

const printer = ts.createPrinter({ removeComments: true })

/** A declaration as its text, without comments, layout, or the modifiers that say whether it is exported */
const textOf = (node: ts.Node): string =>
	printer
		.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
		.replaceAll(/\s+/g, " ")
		.replace(/^(?:export )?(?:declare )?/, "")

type Optionality = Record<string, "optional" | "required">

/** A member a consumer can read or pass: named, neither `#private` nor private, protected or static */
function publicName(member: ts.ClassElement | ts.TypeElement): string | undefined {
	const name = member.name
	if (name === undefined || !(ts.isIdentifier(name) || ts.isStringLiteral(name))) return undefined
	const hidden = [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.StaticKeyword]
	const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : []
	return modifiers.some((modifier) => hidden.includes(modifier.kind)) ? undefined : name.text
}

/** A type element's or a class element's members, each optional or required; a constructor or an index signature names none */
const ownMembers = (members: readonly (ts.ClassElement | ts.TypeElement)[]): Optionality =>
	Object.fromEntries(
		members.flatMap((member) => {
			const name =
				ts.isConstructorDeclaration(member) || ts.isIndexSignatureDeclaration(member) ? undefined : publicName(member)
			const optional = "questionToken" in member && member.questionToken !== undefined
			return name === undefined ? [] : [[name, optional ? "optional" : "required"] as const]
		}),
	)

/** Every part's members together, or undefined when a part's are not known */
const merged = (parts: Array<Optionality | undefined>): Optionality | undefined =>
	parts.some((part) => part === undefined) ? undefined : Object.assign({}, ...parts)

/** The members every arm holds, optional where any arm's is, or undefined when an arm's are not known */
function commonToEvery(arms: Array<Optionality | undefined>): Optionality | undefined {
	if (arms.some((arm) => arm === undefined)) return undefined
	const [first, ...rest] = arms as Optionality[]
	return Object.fromEntries(
		Object.entries(first as Optionality)
			.filter(([name]) => rest.every((arm) => arm[name] !== undefined))
			.map(([name, was]) => [
				name,
				[was, ...rest.map((arm) => arm[name])].includes("optional") ? "optional" : "required",
			]),
	)
}

/** The types an interface or a class extends */
const basesOf = (node: ts.ClassDeclaration | ts.InterfaceDeclaration): ts.ExpressionWithTypeArguments[] =>
	(node.heritageClauses ?? [])
		.filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
		.flatMap((clause) => clause.types)

/**
 * Reads the members a declaration spells out, each optional or required, from its text as a consumer's
 * compiler reads it: a type literal's, an interface's or a class's own and those of the local types it
 * extends (a dependency's base, such as `Error`, adds none), an intersection's arms', the members every
 * arm of a union holds, and `Partial` or `Required` of one of those. Undefined for any other type, such
 * as a mapped type or one a dependency declares, whose members the text does not list.
 */
function memberReader(
	checker: ts.TypeChecker,
	local: (symbol: ts.Symbol) => boolean,
): (declaration: ts.Node, symbol: ts.Symbol) => Optionality | undefined {
	const target = (reference: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments): ts.Symbol | undefined => {
		const found = named(checker, reference)
		const resolved = found === undefined ? undefined : real(checker, found)
		return resolved !== undefined && local(resolved) ? resolved : undefined
	}
	const spelled = (node: ts.Node, seen: ReadonlySet<ts.Symbol>): Optionality | undefined => {
		const each = (nodes: readonly ts.Node[]) => nodes.map((part) => spelled(part, seen))
		if (ts.isTypeLiteralNode(node)) return ownMembers(node.members)
		if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
			const bases = basesOf(node).map((base) => (target(base) === undefined ? {} : referenced(base, seen)))
			return merged([...bases, ownMembers(node.members)])
		}
		if (ts.isTypeAliasDeclaration(node) || ts.isParenthesizedTypeNode(node)) return spelled(node.type, seen)
		if (ts.isIntersectionTypeNode(node)) return merged(each(node.types))
		if (ts.isUnionTypeNode(node)) return commonToEvery(each(node.types))
		if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) return referenced(node, seen)
		return undefined
	}
	/** The members of the type a reference names: a local one's, or `Partial` or `Required` of what it wraps */
	const referenced = (
		reference: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments,
		seen: ReadonlySet<ts.Symbol>,
	): Optionality | undefined => {
		const name = ts.isTypeReferenceNode(reference) ? reference.typeName.getText() : reference.expression.getText()
		const [argument] = reference.typeArguments ?? []
		if ((name === "Partial" || name === "Required") && argument !== undefined) {
			const inner = spelled(argument, seen)
			const now = name === "Partial" ? "optional" : "required"
			return inner === undefined ? undefined : Object.fromEntries(Object.keys(inner).map((member) => [member, now]))
		}
		const found = target(reference)
		const declaration = found === undefined || seen.has(found) ? undefined : found.declarations?.[0]
		return declaration === undefined ? undefined : spelled(declaration, new Set([...seen, found as ts.Symbol]))
	}
	return (declaration, symbol) => spelled(declaration, new Set([symbol]))
}

/** The hashes of what `declarations` exports, by subpath and name, and the members of each type they reach */
function apiIn({ dir, entries }: Declarations): Api {
	const { checker, program } = checkerOf(dir, Object.values(entries))
	const bySubpath = exportsBySubpath(checker, program, entries)
	const local = (symbol: ts.Symbol) => symbol.declarations?.[0]?.getSourceFile().fileName.startsWith(dir) === true
	const reachedTypes = new Set<ts.Symbol>()
	const readMembers = memberReader(checker, local)
	/** The texts of `symbol`'s declarations, then those of each local type they reach, sorted */
	const closure = (symbol: ts.Symbol): string[] => {
		reachedTypes.add(symbol)
		const reached = new Set<string>()
		const seen = new Set<ts.Symbol>()
		const visit = (node: ts.Node): void => {
			const found = named(checker, node)
			const target = found === undefined ? undefined : real(checker, found)
			if (target !== undefined && target !== symbol && !(target.flags & MEMBER) && local(target) && !seen.has(target)) {
				seen.add(target)
				reachedTypes.add(target)
				for (const declaration of target.declarations ?? []) {
					reached.add(textOf(declaration))
					visit(declaration)
				}
			}
			ts.forEachChild(node, visit)
		}
		const own = (symbol.declarations ?? []).map(textOf)
		for (const declaration of symbol.declarations ?? []) visit(declaration)
		return [...new Set(own), ...[...reached].sort()]
	}
	const hash = (symbol: ts.Symbol) =>
		createHash("sha256")
			.update(closure(real(checker, symbol)).join("\n"))
			.digest("hex")
			.slice(0, 16)
	const exports = Object.fromEntries(
		bySubpath.map(([subpath, symbols]) => {
			const hashes = symbols.map((symbol) => [symbol.name, hash(symbol)] as const)
			return [subpath, Object.fromEntries(hashes.sort(([a], [b]) => (a < b ? -1 : 1)))]
		}),
	)
	const members: Members = {}
	for (const symbol of [...reachedTypes].sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const declaration = symbol.declarations?.[0]
		const own = declaration === undefined ? undefined : readMembers(declaration, symbol)
		if (own === undefined) continue
		const sorted = Object.fromEntries(Object.entries(own).sort(([a], [b]) => (a < b ? -1 : 1)))
		const prior = members[symbol.name]
		if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(sorted)) {
			throw new Error(`two types an export reaches are named ${symbol.name}, with different members`)
		}
		members[symbol.name] = sorted
	}
	return { exports, members }
}

/** What the package tree at `root` exports, from the declarations its pack would emit */
export const apiOf = (root: string): Api => withEmitted(root, apiIn)

/** What the packed package at `dir`, a release's tarball unpacked, exports, from the declarations it ships */
export const releasedApiOf = (dir: string): Api => apiIn(packedDeclarations(dir))
