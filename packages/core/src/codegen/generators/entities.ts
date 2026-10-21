/**
 * Entities generator — produces typed entity ID generation from table prefixes.
 *
 * Tables using c.id("prefix") get included in the prefix map.
 * Tables using c.serialId() are skipped (no entity prefix).
 */
import path from "node:path"
import { stringLiteral } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"
import { findNearestPackageJson, setPackageExport } from "../utils/package-json.ts"
import type { GeneratorContext } from "./context-types.ts"

type EntitiesConfig = {
	importFrom?: string | undefined
	output: string
	updatePackageJson?: boolean
}

function generateEntities(ctx: GeneratorContext, config: EntitiesConfig): void {
	const { tables } = ctx.analysis
	const { cwd } = ctx
	const outputPath = path.resolve(cwd, config.output)

	const prefixedTables = tables.flatMap((t) =>
		t.idPrefix === null ? [] : [{ prefix: t.idPrefix, varName: t.varName }],
	)

	if (prefixedTables.length === 0) {
		ctx.log("  entities: no tables with c.id(prefix) — skipped")
		return
	}

	const lines: string[] = []

	const importFrom = config.importFrom ?? "@lovrozagar/comb"
	lines.push(`import { generateId, generateUlid } from "${importFrom}"`)
	lines.push("")

	lines.push("const entityPrefixes = {")
	for (const t of prefixedTables) {
		lines.push(`\t${t.varName}: ${stringLiteral(t.prefix)},`)
	}
	lines.push("} as const")
	lines.push("")

	lines.push("type EntityName = keyof typeof entityPrefixes")
	lines.push("")

	lines.push("function generateEntityId<T extends EntityName>(entity: T): string {")
	lines.push("\treturn generateId(entityPrefixes[entity])")
	lines.push("}")
	lines.push("")

	lines.push("export { entityPrefixes, generateEntityId, generateUlid, type EntityName }")
	lines.push("")

	writeGenFile(outputPath, lines.join("\n"), { generator: "comb", staged: ctx.staged })

	if (config.updatePackageJson) {
		const packageJsonPath = findNearestPackageJson(path.dirname(outputPath), ctx.cwd)
		if (packageJsonPath) {
			setPackageExport(
				packageJsonPath,
				{ namespace: ctx.exportNamespace, staged: ctx.staged, subpath: "./entities" },
				outputPath,
			)
		}
	}

	ctx.log(`  entities: ${outputPath} (${prefixedTables.length} entities)`)
}

/** Walk up from dir to find nearest package.json */
export { generateEntities }
