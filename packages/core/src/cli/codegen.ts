/**
 * `comb codegen`: analyze a tables file and run the generators on it. Config mode runs each
 * database comb.config.ts declares; direct mode (--tables) is one database with the direct set
 * of generators, written beside the tables file.
 */
import path from "node:path"
import type { GeneratorContext } from "../codegen/generators/context-types.ts"
import { parseArgs } from "./args.ts"
import { type CodegenConfig, type DatabaseCodegen, databaseIn, loadCombConfig, tablesFile } from "./comb-config.ts"
import { CliError, type CliIo } from "./output.ts"
import { GENERATORS, type GeneratorName } from "../codegen/config.ts"

type Generator = GeneratorName

/** What direct mode runs: no config means no package exports, ORM driver, translations or FTS */
const DIRECT: readonly Generator[] = [
	"constraints",
	"rows",
	"relations",
	"diagrams",
	"columns",
	"dtos",
	"entities",
	"manifest",
	"enum-checks",
]

/** One database's codegen: its analysis, settings, and where its files go */
type Plan = {
	ctx: GeneratorContext
	db: DatabaseCodegen
	/** Config mode: generated subpaths are added to package.json and filePrefix reaches the files */
	exports: boolean
	/** Where generated files go unless a generator has its own output: output.default, else the tables' directory */
	outDir: string
	/** The stem of every generated file name */
	prefix: string
}

/** Where `generator` writes: the config's override, else `fallback` */
const out = (plan: Plan, generator: Generator, fallback: string) => plan.db.output?.[generator] ?? fallback
const beside = (plan: Plan, suffix: string) => path.join(plan.outDir, `${plan.prefix}.${suffix}`)

// lookup-table: each generator's call, so a plan runs as one loop
const STEPS: Readonly<Record<Generator, (plan: Plan) => Promise<void>>> = {
	columns: async (plan) => {
		const { generateColumns } = await import("../codegen/generators/columns.ts")
		const output = out(plan, "columns", plan.outDir)
		generateColumns(plan.ctx, plan.exports ? { filePrefix: plan.prefix, output, updatePackageJson: true } : { output })
	},
	constraints: async (plan) => {
		const { generateConstraints } = await import("../codegen/generators/constraints.ts")
		generateConstraints(plan.ctx, { output: out(plan, "constraints", beside(plan, "constraints.gen.ts")) })
	},
	diagrams: async (plan) => {
		const { generateDiagrams } = await import("../codegen/generators/diagrams.ts")
		generateDiagrams(plan.ctx, { output: out(plan, "diagrams", path.join(plan.outDir, "diagrams")) })
	},
	dtos: async (plan) => {
		const { generateDtos } = await import("../codegen/generators/dtos/index.ts")
		const output = out(plan, "dtos", path.join(plan.outDir, "dtos"))
		const relationsOutput = out(plan, "relations", beside(plan, "relations.gen.ts"))
		generateDtos(
			plan.ctx,
			plan.exports ? { filePrefix: plan.prefix, output, relationsOutput, updatePackageJson: true } : { output },
		)
	},
	entities: async (plan) => {
		const { generateEntities } = await import("../codegen/generators/entities.ts")
		generateEntities(plan.ctx, {
			output: out(plan, "entities", beside(plan, "entities.gen.ts")),
			updatePackageJson: plan.exports,
		})
	},
	"enum-checks": async (plan) => {
		const { generateEnumChecks } = await import("../codegen/generators/enum-checks.ts")
		generateEnumChecks(plan.ctx, { output: out(plan, "enum-checks", beside(plan, "enum-checks.gen.ts")) })
	},
	"field-names": async (plan) => {
		const { generateFieldNames } = await import("../codegen/generators/field-names.ts")
		const output = out(plan, "field-names", beside(plan, "field-names.gen.ts"))
		generateFieldNames(plan.ctx, { output, updatePackageJson: plan.exports })
	},
	fts: async (plan) => {
		const { fts } = plan.db
		if (!fts || Object.keys(fts).length === 0) return
		const { generateFts } = await import("../codegen/generators/fts.ts")
		generateFts(plan.ctx, { filePrefix: plan.prefix, fts, output: out(plan, "fts", plan.outDir) })
	},
	manifest: async (plan) => {
		const { generateManifest } = await import("../codegen/generators/manifest.ts")
		generateManifest(plan.ctx, { output: out(plan, "manifest", beside(plan, "manifest.gen.json")) })
	},
	orm: async (plan) => {
		const { dialect, driver, filePrefix } = plan.db
		if (!dialect || !driver) return
		const { generateOrm } = await import("../codegen/generators/orm.ts")
		const relationsOutput = path.resolve(plan.ctx.cwd, out(plan, "relations", beside(plan, "relations.gen.ts")))
		generateOrm(plan.ctx, {
			dialect,
			driver,
			filePrefix,
			output: out(plan, "orm", beside(plan, "orm.gen.ts")),
			relationsOutput,
		})
	},
	relations: async (plan) => {
		const { generateRelations } = await import("../codegen/generators/relations.ts")
		generateRelations(plan.ctx, { output: out(plan, "relations", beside(plan, "relations.gen.ts")) })
	},
	rows: async (plan) => {
		const { generateRows } = await import("../codegen/generators/rows.ts")
		generateRows(plan.ctx, { output: out(plan, "rows", beside(plan, "rows.gen.ts")) })
	},
	translations: async (plan) => {
		const { generateTranslations } = await import("../codegen/generators/translations.ts")
		generateTranslations(plan.ctx, { baseDir: plan.outDir, filePrefix: plan.prefix })
	},
}

/** One database to generate for: its settings, and how its plan is built */
type Database = {
	db: DatabaseCodegen
	/** Direct mode: no config, files beside the tables file under the analyzed name */
	direct: boolean
	/** Its namespace in package.json exports, when the package exports another database too */
	exportNamespace: string | undefined
	generators: readonly string[]
	name: string
	tablesPath: string
}

async function analyzed(tablesPath: string, io: CliIo) {
	const { analyze } = await import("../codegen/analyzer.ts")
	const { validateTables } = await import("../codegen/utils/validate.ts")
	const validation = validateTables(tablesPath)
	if (validation.errors.length > 0) {
		throw new CliError(["Validation errors:", ...validation.errors.map((e) => `  ${e}`)].join("\n"))
	}
	for (const warning of validation.warnings) io.err(`  warn: ${warning}`)
	return analyze(tablesPath, io.cwd)
}

/** Where a database's files go unless a generator has its own output: output.default, else the tables' directory */
const outDirOf = (db: DatabaseCodegen, tablesPath: string, cwd: string) =>
	db.output?.["default"] === undefined ? path.dirname(tablesPath) : path.resolve(cwd, db.output["default"])

/**
 * Each database's namespace in package.json exports: its name when its package.json exports
 * another of the config's databases too, so neither overwrites the other's subpaths; none when a
 * package exports one database alone. Every database the config declares counts, whichever run.
 */
async function exportNamespaces(config: CodegenConfig, cwd: string): Promise<Map<string, string>> {
	const { findNearestPackageJson } = await import("../codegen/utils/package-json.ts")
	const byPackage = new Map<string, string[]>()
	for (const [name, db] of Object.entries(config.databases)) {
		const pkg = findNearestPackageJson(outDirOf(db, path.resolve(cwd, db.tables), cwd), cwd) ?? ""
		byPackage.set(pkg, [...(byPackage.get(pkg) ?? []), name])
	}
	const namespaces = new Map<string, string>()
	for (const names of byPackage.values()) if (names.length > 1) for (const name of names) namespaces.set(name, name)
	return namespaces
}

/** Validate, analyze and run `database`'s generators (all, or `only`) */
async function generate(database: Database, only: string | undefined, io: CliIo): Promise<void> {
	const analyzedTables = await analyzed(database.tablesPath, io)
	/* in config mode the database is the one the config names, whatever its tables file is called */
	const analysis = database.direct ? analyzedTables : { ...analyzedTables, dbName: database.name }
	io.out(
		database.direct
			? `Analyzed ${analysis.tables.length} tables (${analysis.dbName})`
			: `  ${analysis.tables.length} tables`,
	)
	const tablesDir = path.dirname(database.tablesPath)
	const plan: Plan = {
		ctx: {
			analysis,
			cwd: database.direct ? tablesDir : io.cwd,
			exportNamespace: database.exportNamespace,
			log: io.out,
			tablesPath: database.tablesPath,
			warn: io.err,
		},
		db: database.db,
		exports: !database.direct,
		outDir: outDirOf(database.db, database.tablesPath, io.cwd),
		prefix: database.direct ? `db.${analysis.dbName}` : (database.db.filePrefix ?? `db.${database.name}`),
	}
	for (const generator of GENERATORS) {
		if (database.generators.includes(generator) && (only === undefined || only === generator))
			await STEPS[generator](plan)
	}
}

/** The databases a codegen run covers: the one --tables names, or those comb.config.ts declares */
async function databases(positionals: readonly string[], tables: string | undefined, io: CliIo): Promise<Database[]> {
	if (tables !== undefined) {
		const tablesPath = tablesFile(io.cwd, tables)
		return [{ db: { tables }, direct: true, exportNamespace: undefined, generators: DIRECT, name: "", tablesPath }]
	}
	const config = await loadCombConfig(io.cwd)
	const names = positionals.length > 0 ? positionals : Object.keys(config.databases)
	const picked = names.map((name) => [name, databaseIn(config, name)] as const)
	const namespaces = await exportNamespaces(config, io.cwd)
	return picked.map(([name, db]) => ({
		db,
		direct: false,
		exportNamespace: namespaces.get(name),
		generators: db.generators ?? GENERATORS,
		name,
		tablesPath: tablesFile(io.cwd, db.tables),
	}))
}

export async function cmdCodegen(argv: readonly string[], io: CliIo): Promise<void> {
	const { options, positionals } = parseArgs(argv, "codegen")
	const only = options["generator"] as string | undefined
	if (only !== undefined && !(GENERATORS as readonly string[]).includes(only)) {
		throw new CliError(`Unknown generator: ${only}. Known: ${GENERATORS.join(", ")}`)
	}
	for (const database of await databases(positionals, options["tables"] as string | undefined, io)) {
		if (!database.direct) io.out(`\nCodegen: ${database.name}`)
		await generate(database, only, io)
	}
}
