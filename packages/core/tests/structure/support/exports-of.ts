/**
 * Every name each export subpath of a package exports, values and types alike, sorted, each with a
 * hash of what a consumer's compiler reads for it: its declaration, and the declaration of every
 * comb-local type it names, followed through those (KT3 of r22b), exported or not, so a type that
 * only becomes exported changes no hash. The hashes read the declarations, a tree's as
 * tsconfig.strict.json emits them and a release's as its tarball ships them, printed without
 * comments, layout, `export` or `declare`: a hash changes when a consumer's compiler would see a
 * change, and only then.
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

const printer = ts.createPrinter({ removeComments: true })

/** A declaration as its text, without comments, layout, or the modifiers that say whether it is exported */
const textOf = (node: ts.Node): string =>
	printer
		.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
		.replaceAll(/\s+/g, " ")
		.replace(/^(?:export )?(?:declare )?/, "")

/** The hash of what `declarations` exports, by subpath and name */
function hashExports({ dir, entries }: Declarations): Exports {
	const { checker, program } = checkerOf(Object.values(entries))
	const bySubpath = exportsBySubpath(checker, program, entries)
	const local = (symbol: ts.Symbol) => symbol.declarations?.[0]?.getSourceFile().fileName.startsWith(dir) === true
	/** The texts of `symbol`'s declarations, then those of each local type they reach, sorted */
	const closure = (symbol: ts.Symbol): string[] => {
		const reached = new Set<string>()
		const seen = new Set<ts.Symbol>()
		const visit = (node: ts.Node): void => {
			const found = named(checker, node)
			const target = found === undefined ? undefined : real(checker, found)
			if (target !== undefined && target !== symbol && !(target.flags & MEMBER) && local(target) && !seen.has(target)) {
				seen.add(target)
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
	return Object.fromEntries(
		bySubpath.map(([subpath, symbols]) => {
			const hashes = symbols.map((symbol) => [symbol.name, hash(symbol)] as const)
			return [subpath, Object.fromEntries(hashes.sort(([a], [b]) => (a < b ? -1 : 1)))]
		}),
	)
}

/** What the package tree at `root` exports, from the declarations its pack would emit */
export const exportsOf = (root: string): Exports => withEmitted(root, hashExports)

/** What the packed package at `dir`, a release's tarball unpacked, exports, from the declarations it ships */
export const releasedExportsOf = (dir: string): Exports => hashExports(packedDeclarations(dir))
