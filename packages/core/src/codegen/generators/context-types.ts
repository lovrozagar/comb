/** What every generator works from: the analysis, where it runs, and where its progress lines go. */
import type { AnalysisResult } from "../analyzer-types.ts"

export type GeneratorContext = {
	analysis: AnalysisResult
	/** the directory relative output paths resolve against */
	cwd: string
	/** a progress line for the person running codegen */
	log: (line: string) => void
	/** the analyzed tables file */
	tablesPath: string
}
