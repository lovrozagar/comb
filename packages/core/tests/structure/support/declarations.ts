/**
 * The declarations a consumer's compiler reads for a package, and the walk from a public
 * declaration to the comb-local types it names (KT3 and KT6 of r22b). A tree's are emitted from its
 * tsconfig.strict.json, as the pack emits them; a release's are the ones its tarball ships.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { Project, ts } from "ts-morph"

/**
 * An exports entry: a file, or from 0.19 the declaration a consumer's tsc reads and the source that
 * runs (K1 of r20), and from 0.21 the declaration for TypeScript 5.7 and later ahead of the floor (KT2)
 */
export type ExportTarget = string | { "types@>=5.7"?: string; types: string; default: string }

/** The source file an exports entry runs, in a release before 0.19 or after */
export const sourceOf = (target: ExportTarget): string => (typeof target === "string" ? target : target.default)

/** The declaration file a supported TypeScript reads for an exports entry; a release before 0.19 shipped none */
function declarationOf(target: ExportTarget): string {
	if (typeof target === "string") throw new Error(`${target} ships no declaration: a release before 0.19`)
	return target["types@>=5.7"] ?? target.types
}

/** Declaration files under `dir`, and the entry among them of each export subpath */
export type Declarations = { dir: string; entries: Record<string, string> }

/** The package at `root`'s export subpaths, but package.json, each with its target */
function subpaths(root: string): Array<[string, ExportTarget]> {
	const { exports } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		exports: Record<string, ExportTarget>
	}
	return Object.entries(exports).filter(([subpath]) => subpath !== "./package.json")
}

/**
 * `use` run on the declarations tsconfig.strict.json emits for the package at `root`, which are gone
 * after. They are emitted inside the package, so their imports of its dependencies resolve, as a
 * consumer's do: in a folder outside it, drizzle-orm and zod resolved to nothing, and the types that
 * name them read as `any`.
 */
export function withEmitted<T>(root: string, use: (declarations: Declarations) => T): T {
	const dir = mkdtempSync(join(root, ".tmp-declarations-"))
	try {
		const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc")
		const args = ["-p", join(root, "tsconfig.strict.json"), "--noEmit", "false", "--emitDeclarationOnly"]
		const run = spawnSync(process.execPath, [tsc, ...args, "--rootDir", join(root, "src"), "--outDir", dir], {
			encoding: "utf8",
		})
		if (run.status !== 0) throw new Error(`tsc failed:\n${run.stdout}${run.stderr}`)
		const entries = subpaths(root)
			.map(([subpath, target]) => [subpath, sourceOf(target)] as const)
			.filter(([, source]) => source.endsWith(".ts"))
			.map(([subpath, source]) => [subpath, join(dir, source.replace(/^\.?\/?src\//, "").replace(/\.ts$/, ".d.ts"))])
		return use({ dir, entries: Object.fromEntries(entries) })
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}

/** The declarations the packed package at `dir` ships, as its exports name them */
export function packedDeclarations(dir: string): Declarations {
	const entries = subpaths(dir).map(([subpath, target]) => [subpath, join(dir, declarationOf(target))])
	return { dir, entries: Object.fromEntries(entries) }
}

/** Each error a compiler reports for the declaration files under `dir`, or for the program as a whole */
export function diagnosticsIn(program: ts.Program, dir: string): string[] {
	const files = program.getSourceFiles().filter((file) => file.fileName.startsWith(dir))
	return [
		...program.getOptionsDiagnostics(),
		...program.getGlobalDiagnostics(),
		...files.flatMap((file) => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]),
	].map(
		(diagnostic) =>
			`${diagnostic.file?.fileName.slice(dir.length + 1) ?? "program"}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
	)
}

/**
 * A checker over the declaration files `files` under `dir`, as a consumer's bundler project reads them. It is built through
 * ts-morph, whose compiler serves TypeScript's libs, and it throws for any error the declarations
 * hold: a lib or an import it cannot find reads as `any`, which answers every question asked of it.
 */
export function checkerOf(dir: string, files: readonly string[]): { checker: ts.TypeChecker; program: ts.Program } {
	const project = new Project({
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			strict: true,
			target: ts.ScriptTarget.ES2023,
			/* comb's declarations name `NodeJS` and node's modules, as its own tsconfig's `types` does */
			types: ["node"],
		},
		skipAddingFilesFromTsConfig: true,
	})
	project.addSourceFilesAtPaths([...files])
	const program = project.getProgram().compilerObject
	const errors = diagnosticsIn(program, dir)
	if (errors.length > 0) throw new Error(`the declarations under ${dir} do not check:\n${errors.join("\n")}`)
	return { checker: program.getTypeChecker(), program }
}

/** The symbol an alias names, or the symbol itself */
export const real = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
	symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol

/** The symbol a type reference, an `extends` clause or a `typeof` names; undefined for any other node */
export function named(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
	if (ts.isTypeReferenceNode(node)) return checker.getSymbolAtLocation(node.typeName)
	if (ts.isTypeQueryNode(node)) return checker.getSymbolAtLocation(node.exprName)
	if (ts.isExpressionWithTypeArguments(node)) return checker.getSymbolAtLocation(node.expression)
	return undefined
}

/** What a declaration names that is part of it, not a type of its own */
export const MEMBER: number = ts.SymbolFlags.TypeParameter | ts.SymbolFlags.Property | ts.SymbolFlags.Method

/** Each entry's exports, by subpath, aliases resolved */
export function exportsBySubpath(
	checker: ts.TypeChecker,
	program: ts.Program,
	entries: Record<string, string>,
): Array<[string, ts.Symbol[]]> {
	return Object.entries(entries).map(([subpath, file]) => {
		const source = program.getSourceFile(file)
		const module = source === undefined ? undefined : checker.getSymbolAtLocation(source)
		return [subpath, module === undefined ? [] : checker.getExportsOfModule(module)]
	})
}
