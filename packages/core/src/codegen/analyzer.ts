/**
 * The analysis every generator consumes: the tables module loaded at runtime in codegen's own
 * child (runtime/load.ts), each table read as drizzle built it and as comb's `c` helpers recorded
 * it (runtime/read-tables.ts), then named as the generators ask (runtime/to-meta.ts). Generators
 * never load or read source themselves.
 */
import type { AnalysisResult, TableMeta } from "./analyzer-types.ts"
import { loadSnapshot } from "./runtime/load.ts"
import { toAnalysis } from "./runtime/to-meta.ts"

// F58
/**
 * Load and analyze a tables file. Loading runs the module in a child process, so it must be safe to
 * import: no top-level connection, server or side effect
 */
async function analyze(
	tablesPath: string,
	{
		cwd,
	}: {
		/** the working directory the module runs in, the one the app runs in; the current process's when omitted */
		cwd?: string | undefined
	} = {},
): Promise<AnalysisResult> {
	return toAnalysis(await loadSnapshot(tablesPath, { cwd }), tablesPath)
}

export { analyze }
export type { AnalysisResult, TableMeta }
