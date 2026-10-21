/** Optional: point the consumer package.json's `exports` at the generated DTOs, tables and relations. */
import path from "node:path"
import { camelToKebab } from "../../utils/case.ts"
import { readStaged, writeJsonAtomic } from "../../utils/fs.ts"
import { exportKey, type ExportTarget, ownsKey, readExports } from "../../utils/package-json.ts"
import type { GeneratorContext } from "../context-types.ts"
import type { DtosConfig } from "./dto-types.ts"

export type PackageExportsInput = { config: DtosConfig; ctx: GeneratorContext; entities: string[] }

/* the subpaths this generator writes for a database, before any namespace */
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
	/* the relations file where the relations generator writes it */
	const relations =
		config.relationsOutput ?? path.join(path.dirname(tablesPath), `db.${ctx.analysis.dbName}.relations.gen.ts`)
	exports["./relations"] = relativeTo(packageDir, path.resolve(ctx.cwd, relations))
	exports["./tables"] = relativeTo(packageDir, tablesPath)
	return Object.fromEntries(Object.entries(exports).map(([key, value]) => [exportKey(ctx.exportNamespace, key), value]))
}

/**
 * Update package.json exports: keep `.` first, then the generated subpaths, then every other
 * subpath the package declares.
 */
export function updatePackageJson(packageJsonPath: string, input: PackageExportsInput): void {
	const pkg = JSON.parse(readStaged(packageJsonPath, input.ctx.staged)) as Record<string, unknown>
	const existing = readExports(pkg)
	const root: Record<string, ExportTarget> = existing["."] === undefined ? {} : { ".": existing["."] }
	const namespace = input.ctx.exportNamespace
	const kept = Object.fromEntries(
		Object.entries(existing).filter(([key]) => key !== "." && !ownsKey(namespace, key, owned)),
	)
	pkg["exports"] = { ...root, ...generatedExports(path.dirname(packageJsonPath), input), ...kept }
	writeJsonAtomic(packageJsonPath, pkg, input.ctx.staged)
	input.ctx.log(`Updated package.json exports with ${input.entities.length} entities`)
}
