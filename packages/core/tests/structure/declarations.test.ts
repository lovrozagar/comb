/**
 * The structure tests that ask a checker about comb's emitted declarations (the export hashes, the
 * members walk, the unexported types) see what a consumer's compiler sees only when that checker
 * resolves every import those declarations make. Emitted where nothing resolved drizzle-orm, zod or
 * TypeScript's own libs, 31 public types and values read as `any` with no diagnostic, so every question about
 * them passed whatever it asked.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { checkerOf, diagnosticsIn, exportsBySubpath, MEMBER, named, real, withEmitted } from "./support/declarations.ts"

const ROOT = join(import.meta.dirname, "../..")

/** Whether a declaration's own text spells `any` */
const spellsAny = (node: ts.Node): boolean =>
	node.kind === ts.SyntaxKind.AnyKeyword || ts.forEachChild(node, (child) => spellsAny(child) || undefined) === true

describe("the checker over comb's emitted declarations", () => {
	const { diagnostics, unresolved } = withEmitted(ROOT, ({ dir, entries }) => {
		const { checker, program } = checkerOf(dir, Object.values(entries))
		const local = (symbol: ts.Symbol) => symbol.declarations?.[0]?.getSourceFile().fileName.startsWith(dir) === true
		const seen = new Set<ts.Symbol>()
		const visit = (node: ts.Node): void => {
			const found = named(checker, node)
			const target = found === undefined ? undefined : real(checker, found)
			if (target !== undefined && !(target.flags & MEMBER) && local(target) && !seen.has(target)) {
				seen.add(target)
				for (const declaration of target.declarations ?? []) visit(declaration)
			}
			ts.forEachChild(node, visit)
		}
		for (const [, symbols] of exportsBySubpath(checker, program, entries))
			for (const symbol of symbols) {
				const target = real(checker, symbol)
				seen.add(target)
				for (const declaration of target.declarations ?? []) visit(declaration)
			}
		const typeOf = (symbol: ts.Symbol): ts.Type =>
			symbol.flags & (ts.SymbolFlags.Type & ~ts.SymbolFlags.Value)
				? checker.getDeclaredTypeOfSymbol(symbol)
				: checker.getTypeOfSymbol(symbol)
		return {
			diagnostics: diagnosticsIn(program, dir),
			unresolved: [...seen]
				.filter((symbol) => typeOf(symbol).flags & ts.TypeFlags.Any)
				.filter((symbol) => !(symbol.declarations ?? []).some(spellsAny))
				.map((symbol) => symbol.name)
				.sort(),
		}
	})

	it("reads no public type, or type one reaches, as `any` but where its declaration says `any`", () => {
		expect(unresolved).toEqual([])
	})

	it("reports nothing on the declarations: every import resolves, TypeScript's libs among them", () => {
		expect(diagnostics).toEqual([])
	})
})

/**
 * The projects a consumer without Node's types runs, a Workers one and a browser bundle: comb lists
 * @types/node only as a dev dependency, so a declaration naming `NodeJS` fails such a project with
 * TS2503, or under skipLibCheck reads as `any` and accepts anything
 */
const WITHOUT_NODE = {
	browser: { lib: ["lib.es2023.d.ts", "lib.dom.d.ts"], types: [] },
	workers: { lib: ["lib.es2023.d.ts"], types: ["@cloudflare/workers-types"] },
} satisfies Record<string, { lib: string[]; types: string[] }>

/** Each error a project without Node's types reports on `files` under `dir` */
function withoutNode(
	project: keyof typeof WITHOUT_NODE,
	{ dir, files, skipLibCheck }: { dir: string; files: readonly string[]; skipLibCheck: boolean },
) {
	const checked = new Project({
		compilerOptions: {
			...WITHOUT_NODE[project],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			skipLibCheck,
			strict: true,
			target: ts.ScriptTarget.ES2023,
		},
		skipAddingFilesFromTsConfig: true,
	})
	checked.addSourceFilesAtPaths([...files])
	return diagnosticsIn(checked.getProgram().compilerObject, dir)
}

describe.each(Object.keys(WITHOUT_NODE) as Array<keyof typeof WITHOUT_NODE>)(
	"comb's emitted declarations in a %s project, without Node's types",
	(project) => {
		const { decay, diagnostics } = withEmitted(ROOT, ({ dir, entries }) => {
			const cli = entries["./cli"]
			if (cli === undefined) throw new Error("no ./cli entry")
			const probe = join(dir, "probe.ts")
			const from = `./${relative(dir, cli).replace(/\.d\.ts$/, ".js")}`
			writeFileSync(probe, `import type { Terminal } from "${from}"\nexport const bad: Terminal["output"] = 42\n`)
			return {
				decay: withoutNode(project, { dir, files: [probe], skipLibCheck: true }),
				diagnostics: withoutNode(project, { dir, files: Object.values(entries), skipLibCheck: false }),
			}
		})

		it("reports nothing on any entry's declarations", () => {
			expect(diagnostics).toEqual([])
		})

		it("keeps Terminal typed under skipLibCheck, so a number is no output stream", () => {
			expect(decay).toEqual([expect.stringMatching(/^probe\.ts: Type 'number' is not assignable to type /)])
		})
	},
)

describe("a checker over declarations that do not check", () => {
	it("throws, naming each error, rather than read what it cannot resolve as `any`", () => {
		const dir = mkdtempSync(join(ROOT, ".tmp-declarations-broken-"))
		try {
			writeFileSync(
				join(dir, "index.d.ts"),
				'import type { Gone } from "no-such-package"\nexport type Uses = { gone: Gone }\n',
			)
			expect(() => checkerOf(dir, [join(dir, "index.d.ts")])).toThrow(
				"index.d.ts: Cannot find module 'no-such-package' or its corresponding type declarations.",
			)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	})
})
