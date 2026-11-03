/**
 * The comb-local types a consumer meets in comb's public declarations but cannot import (KT6 of
 * r22b): each type or value a public declaration names, through a type reference, an `extends` or
 * a `typeof`, that no export subpath exports, followed through the declarations of those it finds.
 * It walks the declarations a consumer's compiler reads, emitted from tsconfig.strict.json as the
 * pack emits them, with the walk of `.tmp/grunt/r22b/consumers-types/A-unexported-types.ts`.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { ts } from "ts-morph"
import { type ExportTarget, sourceOf } from "./exports-of.ts"

/** Each unexported type as `Name (file.d.ts)`, with the chain of public names that reaches it */
export type Unexported = Map<string, string>

const real = (checker: ts.TypeChecker, symbol: ts.Symbol) =>
	symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol

/** The symbol a type reference, an `extends` clause or a `typeof` names; undefined for any other node */
function named(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
	if (ts.isTypeReferenceNode(node)) return checker.getSymbolAtLocation(node.typeName)
	if (ts.isTypeQueryNode(node)) return checker.getSymbolAtLocation(node.exprName)
	if (ts.isExpressionWithTypeArguments(node)) return checker.getSymbolAtLocation(node.expression)
	return undefined
}

const MEMBER = ts.SymbolFlags.TypeParameter | ts.SymbolFlags.Property | ts.SymbolFlags.Method

/** What the declaration files `entries` export, and every local type under `dir` they name that none exports */
export function unexportedIn(dir: string, entries: readonly string[]): Unexported {
	const program = ts.createProgram([...entries], {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: ts.ScriptTarget.ES2023,
	})
	const checker = program.getTypeChecker()
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
export function unexportedTypes(root: string): Unexported {
	const out = mkdtempSync(join(tmpdir(), "comb-public-types-"))
	try {
		const tsc = join(
			dirname(createRequire(join(root, "package.json")).resolve("typescript/package.json")),
			"bin",
			"tsc",
		)
		const args = ["-p", join(root, "tsconfig.strict.json"), "--noEmit", "false", "--emitDeclarationOnly"]
		const run = spawnSync(process.execPath, [tsc, ...args, "--rootDir", join(root, "src"), "--outDir", out], {
			encoding: "utf8",
		})
		if (run.status !== 0) throw new Error(`tsc failed:\n${run.stdout}${run.stderr}`)
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			exports: Record<string, ExportTarget>
		}
		const entries = Object.entries(manifest.exports)
			.filter(([key]) => key !== "./package.json")
			.map(([, target]) => sourceOf(target))
			.filter((source) => source.endsWith(".ts"))
			.map((source) => join(out, source.replace(/^\.?\/?src\//, "").replace(/\.ts$/, ".d.ts")))
		return unexportedIn(out, entries)
	} finally {
		rmSync(out, { force: true, recursive: true })
	}
}
