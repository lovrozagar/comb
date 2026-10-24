/**
 * The analysis every generator consumes: the tables module loaded at runtime in codegen's own
 * child (runtime/load.ts), each table read as drizzle built it and as comb's `c` helpers recorded
 * it (runtime/read-tables.ts), then named as the generators ask (runtime/to-meta.ts). Generators
 * never load or read source themselves.
 */
import type { AnalysisResult, TableMeta } from "./analyzer-types.ts"
import { loadSnapshot } from "./runtime/load.ts"
import { toAnalysis } from "./runtime/to-meta.ts"

/** Load and analyze a tables file. Loading runs the module, which must be import-safe. */
function analyze(tablesPath: string): AnalysisResult {
	return toAnalysis(loadSnapshot(tablesPath), tablesPath)
}

export { analyze }
export type { AnalysisResult, TableMeta }
