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

export type GeneratorName = (typeof GENERATORS)[number]

type OrmConfig = Parameters<typeof generateOrm>[1]

export type DatabaseCodegen = {
	dialect?: OrmConfig["dialect"] | undefined
	driver?: OrmConfig["driver"] | undefined
	/** The stem of every generated file name; `db.<name>` when omitted */
	filePrefix?: string | undefined
	fts?: Record<string, FtsTableConfig> | undefined
	/** The generators to run; all when omitted */
	generators?: readonly GeneratorName[] | undefined
	/** Where each generator writes; `default` is the directory for every one not named */
	output?: Partial<Record<GeneratorName | "default", string>> | undefined
	/** The tables file, relative to comb.config.ts */
	tables: string
}

export type CodegenConfig = { databases: Record<string, DatabaseCodegen> }

/** `config`, typed: the identity a comb.config.ts exports through */
export function defineCodegenConfig(config: CodegenConfig): CodegenConfig {
	return config
}
