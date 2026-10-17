/** Optional: point the consumer package.json's `exports` at the generated DTOs, tables and relations. */
import fs from "node:fs"
import path from "node:path"
import { camelToKebab } from "../../utils/case.ts"
import { writeJsonAtomic } from "../../utils/fs.ts"
import { type ExportTarget, readExports } from "../../utils/package-json.ts"
import { extractDbName } from "../../utils/ts-morph.ts"
import type { GeneratorContext } from "../context-types.ts"
import type { DtosConfig } from "./dto-types.ts"

export type PackageExportsInput = { config: DtosConfig; ctx: GeneratorContext; entities: string[] }

/* the subpaths this generator owns and rewrites on every run */
const owned = (key: string) => key.startsWith("./dtos/") || key === "./tables" || key === "./relations"

const relativeTo = (from: string, to: string) => `./${path.relative(from, to)}`

/** The generated subpaths, in a stable order. */
function generatedExports(packageDir: string, { config, ctx, entities }: PackageExportsInput): Record<string, string> {
	const outputDir = relativeTo(packageDir, path.resolve(ctx.cwd, config.output))
	const prefix = config.filePrefix
	const exports: Record<string, string> = {
		"./dtos/_shared": `${outputDir}/_shared/${prefix ? `${prefix}._shared.gen.ts` : "index.gen.ts"}`,
	}
	for (const entity of [...entities].sort()) {
		const kebabName = camelToKebab(entity)
		exports[`./dtos/${kebabName}`] =
			`${outputDir}/${kebabName}/${prefix ? `${prefix}.${kebabName}.gen.ts` : "index.gen.ts"}`
	}
	const tablesPath = path.resolve(ctx.cwd, ctx.tablesPath)
	const relations = `${prefix ?? `db.${extractDbName(ctx.tablesPath)}`}.relations.gen.ts`
	exports["./relations"] = relativeTo(packageDir, path.join(path.dirname(tablesPath), relations))
	exports["./tables"] = relativeTo(packageDir, tablesPath)
	return exports
}

/**
 * Update package.json exports: keep `.` first, then the generated subpaths, then every other
 * subpath the package declares.
 */
export function updatePackageJson(packageJsonPath: string, input: PackageExportsInput): void {
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>
	const existing = readExports(pkg)
	const root: Record<string, ExportTarget> = existing["."] === undefined ? {} : { ".": existing["."] }
	const kept = Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "." && !owned(key)))
	pkg["exports"] = { ...root, ...generatedExports(path.dirname(packageJsonPath), input), ...kept }
	writeJsonAtomic(packageJsonPath, pkg)
	input.ctx.log(`Updated package.json exports with ${input.entities.length} entities`)
}
