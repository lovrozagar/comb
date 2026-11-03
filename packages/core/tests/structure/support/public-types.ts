/**
 * The comb-local types a consumer meets in comb's public declarations but cannot import (KT6 of
 * r22b): each type or value a public declaration names, through a type reference, an `extends` or
 * a `typeof`, that no export subpath exports, followed through the declarations of those it finds.
 * It walks the declarations a consumer's compiler reads, emitted from tsconfig.strict.json as the
 * pack emits them, with the walk of `.tmp/grunt/r22b/consumers-types/A-unexported-types.ts`.
 */
import { relative } from "node:path"
import { ts } from "ts-morph"
import { checkerOf, exportsBySubpath, MEMBER, named, real, withEmitted } from "./declarations.ts"

/** Each unexported type as `Name (file.d.ts)`, with the chain of public names that reaches it */
export type Unexported = Map<string, string>

/** What the declaration files `entries` export, and every local type under `dir` they name that none exports */
export function unexportedIn(dir: string, entries: readonly string[]): Unexported {
	const { checker, program } = checkerOf(entries)
	const local = (symbol: ts.Symbol) => symbol.declarations?.[0]?.getSourceFile().fileName.startsWith(dir) === true
	const exported = new Set(
		entries.flatMap((file) => {
			const source = program.getSourceFile(file)
			const module = source === undefined ? undefined : checker.getSymbolAtLocation(source)
			return module === undefined ? [] : checker.getExportsOfModule(module).map((symbol) => real(checker, symbol))
		}),
	)
	const found: Unexported = new Map()
	const seen = new Set(exported)
	const visit = (declaration: ts.Node, from: string): void => {
		const symbol = named(checker, declaration)
		const target = symbol === undefined ? undefined : real(checker, symbol)
		if (target !== undefined && !(target.flags & MEMBER) && local(target) && !seen.has(target)) {
			seen.add(target)
			const file = relative(dir, target.declarations?.[0]?.getSourceFile().fileName ?? "")
			found.set(`${target.name} (${file})`, from)
			for (const next of target.declarations ?? []) visit(next, `${target.name} <- ${from}`)
		}
		ts.forEachChild(declaration, (child) => visit(child, from))
	}
	for (const symbol of exported)
		for (const declaration of symbol.declarations ?? []) if (local(symbol)) visit(declaration, symbol.name)
	return found
}

/** The package at `root`'s TypeScript export subpaths, as tsconfig.strict.json emits their declarations */
export const unexportedTypes = (root: string): Unexported =>
	withEmitted(root, ({ dir, entries }) => unexportedIn(dir, Object.values(entries)))

/** What one subpath's declarations name and it does not export, and the names each subpath exports */
export type BySubpath = { exports: Map<string, Set<string>>; found: Map<string, Unexported> }

/**
 * Each export subpath's own walk (AD4 of the area D review): a consumer names a type from the
 * subpath whose declaration uses it, so each subpath's exports alone count as exported there
 */
export const unexportedBySubpath = (root: string): BySubpath =>
	withEmitted(root, ({ dir, entries }) => {
		const { checker, program } = checkerOf(Object.values(entries))
		const exports = new Map(
			exportsBySubpath(checker, program, entries).map(([subpath, symbols]) => [
				subpath,
				new Set(symbols.map((symbol) => symbol.name)),
			]),
		)
		const found = new Map(Object.entries(entries).map(([subpath, file]) => [subpath, unexportedIn(dir, [file])]))
		return { exports, found }
	})
