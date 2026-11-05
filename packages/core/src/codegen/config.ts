/**
 * comb.config.ts: the databases `comb codegen` and `comb migrate diff` read. Write it through
 * defineCodegenConfig so a mistyped generator, output key or driver fails to compile.
 */
import type { FtsTableConfig } from "./generators/fts-sql.ts"
import type { generateOrm } from "./generators/orm.ts"

export type { FtsTableConfig }

/** Every generator, in the order codegen runs them */
export const GENERATORS = [
	"constraints",
	"rows",
	"relations",
	"diagrams",
	"columns",
	"dtos",
	"entities",
	"manifest",
	"field-names",
	"orm",
	"enum-checks",
	"translations",
	"fts",
] as const

/** A generator a database's `generators` and `output` name */
export type GeneratorName = (typeof GENERATORS)[number]

/** What the orm generator takes: the dialect and driver its client factories are written for */
export type OrmConfig = Parameters<typeof generateOrm>[1]

/** One database's codegen: its tables file and what is generated from it */
export type DatabaseCodegen = {
	/** the database's dialect; the tables' own when omitted, else `sqlite`. One the tables contradict throws */
	dialect?: OrmConfig["dialect"] | undefined
	/** the driver the orm client is written for; the orm generator writes nothing without it */
	driver?: OrmConfig["driver"] | undefined
	/** The stem of every generated file name; `db.<name>` when omitted */
	filePrefix?: string | undefined
	/** SQLite full-text search: each table, by its export name, to its index; the fts generator writes nothing without it */
	fts?: Record<string, FtsTableConfig> | undefined
	/** The generators to run; all when omitted */
	generators?: readonly GeneratorName[] | undefined
	/** Where each generator writes; `default` is the directory for every one not named */
	output?: { [K in GeneratorName | "default"]?: string | undefined } | undefined
	/**
	 * Postgres only: each partitioned table, keyed as its constraint map keys it, to its partitions'
	 * names, which live in its schema. Postgres reports a violation on the partition, and the map
	 * reads it as the parent's; a violation on a partition not listed names no column
	 */
	// Q7 of r18
	partitions?: Record<string, readonly string[]> | undefined
	/** The tables file, relative to comb.config.ts */
	tables: string
}

/** What comb.config.ts exports */
export type CodegenConfig = {
	/** each database, by the name `comb codegen` and `comb migrate diff` select it by and its generated files take (`db.<name>`) */
	databases: Record<string, DatabaseCodegen>
}

/** `config`, typed: the identity a comb.config.ts exports through */
export function defineCodegenConfig(config: CodegenConfig): CodegenConfig {
	return config
}
