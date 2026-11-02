/**
 * Every name each export subpath of the package at `root` exports, values and types alike, sorted,
 * read with ts-morph from the entry files package.json names, as a consumer's compiler sees them.
 * Each name holds a hash of its emitted declaration, whitespace normalized: no function body and no
 * comment reach it, so it changes when a consumer's compiler would see a change, and only then.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type ExportedDeclarations, Project, type SourceFile } from "ts-morph"

export type Exports = Record<string, Record<string, string>>

/** The declaration file `source` emits, read in `into`, each source's once */
function emitter(into: Project): (source: SourceFile) => SourceFile {
	const emitted = new Map<string, SourceFile>()
	return (source) => {
		const path = source.getFilePath()
		const known = emitted.get(path)
		if (known) return known
		const [file] = source.getEmitOutput({ emitOnlyDtsFiles: true }).getOutputFiles()
		const parsed = into.createSourceFile(`/${emitted.size}.d.ts`, file?.getText() ?? "")
		emitted.set(path, parsed)
		return parsed
	}
}

/** The hash of what `declarations`, the overloads of one name, emit */
function hashOf(name: string, declarations: ExportedDeclarations[], emit: ReturnType<typeof emitter>): string {
	const texts = declarations.flatMap((declaration) => {
		const named = declaration as ExportedDeclarations & { getName?: () => string | undefined }
		const local = emit(declaration.getSourceFile()).getLocal(named.getName?.() ?? name)
		if (local === undefined) throw new Error(`no emitted declaration for ${name}`)
		return local.getDeclarations().map((node) => node.getText())
	})
	const normalized = [...new Set(texts)].join("\n").replaceAll(/\s+/g, " ")
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16)
}

export function exportsOf(root: string): Exports {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, string> }
	const project = new Project({
		compilerOptions: { declaration: true, emitDeclarationOnly: true, noEmit: false, removeComments: true },
		skipAddingFilesFromTsConfig: true,
		tsConfigFilePath: join(root, "tsconfig.json"),
	})
	const emit = emitter(new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: true }))
	return Object.fromEntries(
		Object.entries(manifest.exports)
			.filter(([subpath, file]) => subpath !== "./package.json" && file.endsWith(".ts"))
			.map(([subpath, file]) => {
				const exported = [...project.addSourceFileAtPath(join(root, file)).getExportedDeclarations()]
				const hashes = exported.map(([name, declarations]) => [name, hashOf(name, declarations, emit)] as const)
				return [subpath, Object.fromEntries(hashes.sort(([a], [b]) => (a < b ? -1 : 1)))]
			}),
	)
}
