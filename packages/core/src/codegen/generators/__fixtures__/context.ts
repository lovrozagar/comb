/** A GeneratorContext for generator tests: it records what the generator logs and warns. */
import type { AnalysisResult, TableMeta } from "../../analyzer-types.ts"
import type { GeneratorContext } from "../context-types.ts"

type TestContext = GeneratorContext & { logged: string[]; warned: string[] }

type ContextOptions = { cwd: string; dbName?: string; dialect?: GeneratorContext["dialect"]; tablesPath?: string }

function emptyImports(): AnalysisResult["imports"] {
	return { enumImports: new Map(), identifiers: new Map(), jsonSchemaImports: new Set() }
}

/** Build from an analyzer result, or from hand-made tables under `dbName` (default "test"). */
function testContext(
	source: AnalysisResult | TableMeta[],
	{ cwd, dbName = "test", dialect = "sqlite", tablesPath = "" }: ContextOptions,
): TestContext {
	const analysis = Array.isArray(source)
		? { dbName, dialect, imports: emptyImports(), tables: source, tablesImportPath: "" }
		: source
	const logged: string[] = []
	const warned: string[] = []
	return {
		analysis,
		cwd,
		dialect,
		importStyle: "bare",
		log: (line) => logged.push(line),
		logged,
		tablesPath,
		warn: (line) => warned.push(line),
		warned,
	}
}

export { testContext, type TestContext }
