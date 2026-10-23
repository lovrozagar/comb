/**
 * comb's Postgres parser: libpg-query 17, the parser of the server comb migrates, an optional peer.
 * `loadPostgresParser()` loads it once; every comb path that classifies a Postgres migration
 * awaits it first, and a caller of `classifyMigration` on Postgres does too.
 */

type Parser = { parseSync(sql: string): { stmts?: unknown } }

// per-process-constant: the parser module, set once by loadPostgresParser
let parser: Parser | undefined

/** Load libpg-query, comb's Postgres parser, once; a Postgres file is classified only after it */
async function loadPostgresParser(): Promise<void> {
	if (parser !== undefined) return
	let lib: Parser & { loadModule(): Promise<void> }
	try {
		lib = (await import("libpg-query")) as unknown as Parser & { loadModule(): Promise<void> }
	} catch (error) {
		throw new Error(
			`comb reads Postgres migrations with libpg-query: install libpg-query@17.7.4 (${(error as Error).message})`,
			{ cause: error },
		)
	}
	await lib.loadModule()
	parser = lib
}

/** The loaded parser; throws when it was never loaded */
function postgresParser(): Parser {
	if (parser === undefined)
		throw new Error("call loadPostgresParser() before classifying a Postgres migration: comb reads it with libpg-query")
	return parser
}

export { loadPostgresParser, postgresParser }
