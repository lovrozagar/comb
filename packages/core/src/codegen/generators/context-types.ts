/** What every generator works from: the analysis, where it runs, and where its progress lines go. */
import type { AnalysisResult } from "../analyzer-types.ts"

export type GeneratorContext = {
	analysis: AnalysisResult
	/** the directory relative output paths resolve against */
	cwd: string
	/** the database's engine: what a column type holds, and which drizzle core a file imports from */
	dialect: "postgres" | "sqlite"
	/** a progress line for the person running codegen */
	log: (line: string) => void
	/**
	 * The database's namespace in its package.json exports (`./<namespace>/…`), set when one
	 * package exports several databases; undefined when it exports this one alone
	 */
	exportNamespace?: string | undefined
	/** where a codegen run holds its writes, by path, until every generator has run; none writes at once */
	staged?: Map<string, string> | undefined
	/** the analyzed tables file */
	tablesPath: string
	/** a line the person running codegen should act on */
	warn: (line: string) => void
}
