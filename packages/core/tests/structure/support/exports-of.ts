/**
 * Every name each export subpath of a package exports, values and types alike, sorted, each with a
 * hash of what a consumer's compiler reads for it: its declaration, and the declaration of every
 * comb-local type it names, followed through those (KT3 of r22b), exported or not, so a type that
 * only becomes exported changes no hash. The hashes read the declarations, a tree's as
 * tsconfig.strict.json emits them and a release's as its tarball ships them, printed without
 * comments, layout, `export` or `declare`: a hash changes when a consumer's compiler would see a
 * change, and only then. Beside them, the members of every type an export reaches, its own type or
 * one it names, each optional or required, by the type's name: what a removed member or one that
 * became required is read from, which no hash names. And the types a callable export takes, by
 * parameter reach, so a member added to one as required is read too (AD7-3 of the area D round-seven review).
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

/**
 * A package's exports with their hashes, the members of the types they reach, and the names of the
 * types a callable export takes, which a consumer writes: a member added to one as required breaks it
 */
export type Api = { exports: Exports; inputs: string[]; members: Members }

const printer = ts.createPrinter({ removeComments: true })

/** A declaration as its text, without comments, layout, or the modifiers that say whether it is exported */
const textOf = (node: ts.Node): string =>
	printer
		.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
		.replaceAll(/\s+/g, " ")
		.replace(/^(?:export )?(?:declare )?/, "")

type Optionality = Record<string, "optional" | "required">

/** The symbols whose declared type a consumer reads members of: an interface's, a class's instances', an alias's */
const HAS_MEMBERS = ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.TypeAlias

/** The exports a consumer calls or constructs, passing what their parameters take */
const CALLABLE = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable

const HIDDEN = ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static

/** A member a consumer can read or pass: neither `#private` nor private, protected or static */
const isPublic = (member: ts.Symbol): boolean =>
	!(member.declarations ?? []).some(
		(declaration) =>
			ts.getCombinedModifierFlags(declaration as ts.Declaration) & HIDDEN ||
			ts.getNameOfDeclaration(declaration as ts.Declaration)?.kind === ts.SyntaxKind.PrivateIdentifier,
	)

/**
 * The members a consumer's compiler gives the type `symbol` declares, each optional or required: what
 * an interface or a class holds with its local bases', what every arm of a union holds, and what an
 * intersection, a mapped type, a computed key or a `z.infer` resolves to. A member a dependency
 * declares, such as `Error`'s `message` or a `z.ZodObject`'s `parse`, is left out: it is the
 * dependency's to change, and comb's declarations hash already moves when comb's own use of it does.
 * Undefined for a type that is not an object, or a union with an arm that is not.
 */
function membersOf(
	checker: ts.TypeChecker,
	symbol: ts.Symbol,
	inPackage: (node: ts.Node) => boolean,
): Optionality | undefined {
	if (!(symbol.flags & HAS_MEMBERS)) return undefined
	const type = checker.getDeclaredTypeOfSymbol(symbol)
	const arms = type.isUnion() ? type.types : [type]
	if (!arms.every((arm) => arm.flags & ts.TypeFlags.Object || arm.isIntersection())) return undefined
	const declared = (member: ts.Symbol) =>
		(member.declarations ?? []).length === 0 || (member.declarations ?? []).some(inPackage)
	return Object.fromEntries(
		checker
			.getPropertiesOfType(type)
			.filter((member) => isPublic(member) && declared(member))
			.map((member) => [member.name, member.flags & ts.SymbolFlags.Optional ? "optional" : "required"] as const)
			.sort(([a], [b]) => (a < b ? -1 : 1)),
	)
}

type Found = { exported: boolean; members: Optionality; name: string }

/**
 * Each type's members by its name, which is what a consumer and an Upgrading section call it. Types of
 * one name with different members throw, so the newer is renamed in src. A release is past renaming:
 * there, the one type of the name an entry exports stands for it (0.20.1 reached the exported
 * ListQueryInput beside the z.ZodObject list-schema.ts called by that name, since ListQueryRequest).
 */
function byName(found: Found[], released: boolean): Members {
	const members: Members = {}
	for (const [name, types] of Map.groupBy(found, (type) => type.name)) {
		const distinct = new Set(types.map((type) => JSON.stringify(type.members)))
		const exported = types.filter((type) => type.exported)
		const kept = distinct.size === 1 ? types[0] : released && exported.length === 1 ? exported[0] : undefined
		if (kept === undefined) throw new Error(`two types an export reaches are named ${name}, with different members`)
		members[name] = kept.members
	}
	return Object.fromEntries(Object.entries(members).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * The names of the types the callables of `exported` take, sorted: each local type named under a
 * parameter of a function, class or const, and each local type those name
 */
function inputsOf(
	checker: ts.TypeChecker,
	exported: ReadonlySet<ts.Symbol>,
	local: (symbol: ts.Symbol) => boolean,
): string[] {
	const inputs = new Set<ts.Symbol>()
	const takes = (node: ts.Node, inParameter: boolean): void => {
		const found = inParameter ? named(checker, node) : undefined
		const target = found === undefined ? undefined : real(checker, found)
		if (target !== undefined && !(target.flags & MEMBER) && local(target) && !inputs.has(target)) {
			inputs.add(target)
			for (const declaration of target.declarations ?? []) takes(declaration, true)
		}
		ts.forEachChild(node, (child) => takes(child, inParameter || ts.isParameter(child)))
	}
	for (const symbol of exported)
		if (symbol.flags & CALLABLE) for (const declaration of symbol.declarations ?? []) takes(declaration, false)
	const typed = [...inputs].filter((symbol) => symbol.flags & HAS_MEMBERS).map((symbol) => symbol.name)
	return [...new Set(typed)].sort()
}

/** The hashes of what `declarations` exports, by subpath and name, and the members of each type they reach, `released` or not */
function apiIn({ dir, entries }: Declarations, released: boolean): Api {
	const { checker, program } = checkerOf(dir, Object.values(entries))
	const bySubpath = exportsBySubpath(checker, program, entries)
	const local = (symbol: ts.Symbol) => symbol.declarations?.[0]?.getSourceFile().fileName.startsWith(dir) === true
	const reachedTypes = new Set<ts.Symbol>()
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
	const exported = new Set(bySubpath.flatMap(([, symbols]) => symbols.map((symbol) => real(checker, symbol))))
	const inPackage = (node: ts.Node) => node.getSourceFile().fileName.startsWith(dir)
	const members = byName(
		[...reachedTypes].flatMap((symbol) => {
			const own = membersOf(checker, symbol, inPackage)
			return own === undefined ? [] : [{ exported: exported.has(symbol), members: own, name: symbol.name }]
		}),
		released,
	)
	return { exports, inputs: inputsOf(checker, exported, local), members }
}

/** What the package tree at `root` exports, from the declarations its pack would emit */
export const apiOf = (root: string): Api => withEmitted(root, (declarations) => apiIn(declarations, false))

/** What the packed package at `dir`, a release's tarball unpacked, exports, from the declarations it ships */
export const releasedApiOf = (dir: string): Api => apiIn(packedDeclarations(dir), true)
