/**
 * comb's Postgres parser: libpg-query 17, the parser of the server comb migrates, an optional peer.
 * `loadPostgresParser()` loads it once; every comb path that classifies a Postgres migration
 * awaits it first, and a caller of `classifyMigration` on Postgres does too.
 */

import { qualifySchemaElements } from "./pg-schema-elts.ts"

type Parser = { parseSync(sql: string): { stmts?: unknown } }

/* an optional peer, named by a string so a consumer without it still type-checks comb (K2 of r17) */
const LIBPG_QUERY: string = "libpg-query"

// per-process-constant: the parser module, set once by loadPostgresParser
let parser: Parser | undefined

/** Load libpg-query, comb's Postgres parser, once; a Postgres file is classified only after it */
async function loadPostgresParser(): Promise<void> {
	if (parser !== undefined) return
	let lib: Parser & { loadModule(): Promise<void> }
	try {
		lib = (await import(LIBPG_QUERY)) as Parser & { loadModule(): Promise<void> }
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

/**
 * `sql` parsed by the loaded parser, the one way comb parses Postgres: names inside CREATE SCHEMA
 * elements qualified as Postgres resolves them (pg-schema-elts.ts), before anything keeps the tree
 */
function parsePostgres(sql: string): { stmts?: unknown } {
	const tree = postgresParser().parseSync(sql)
	qualifySchemaElements(tree.stmts)
	return tree
}

export { loadPostgresParser, parsePostgres, postgresParser }
