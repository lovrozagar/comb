/**
 * Every name each export subpath of the package at `root` exports, values and types alike, sorted:
 * read with ts-morph from the entry files package.json names, as a consumer's compiler sees them.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Project } from "ts-morph"

export type Exports = Record<string, string[]>

export function exportsOf(root: string): Exports {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, string> }
	const project = new Project({ skipAddingFilesFromTsConfig: true, tsConfigFilePath: join(root, "tsconfig.json") })
	return Object.fromEntries(
		Object.entries(manifest.exports)
			.filter(([subpath, file]) => subpath !== "./package.json" && file.endsWith(".ts"))
			.map(([subpath, file]) => {
				const source = project.addSourceFileAtPath(join(root, file))
				return [subpath, [...source.getExportedDeclarations().keys()].sort()]
			}),
	)
}
