/** comb.config.ts: the databases codegen and migrate diff read their tables and FTS from. */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import * as z from "zod"
import type { CodegenConfig, DatabaseCodegen } from "../codegen/config.ts"
import type { FtsTableConfig } from "../codegen/generators/fts-sql.ts"
import { codegenConfigSchema } from "../codegen/config-schema.ts"
import { CliError, type CliIo } from "./output.ts"

export type { CodegenConfig, DatabaseCodegen }

/** `exported`, the config file `file` exports, held to its schema; a CliError naming the file and each key that is wrong (K14) */
function parsed(file: string, exported: unknown): CodegenConfig {
	const result = codegenConfigSchema().safeParse(exported)
	if (result.success) return result.data
	throw new CliError(`${file} is not a valid comb config:\n${z.prettifyError(result.error)}`)
}

/**
 * The config module `file`, a .json one parsed as its default export; a syntax error or a throw names
 * `file`, the error as its cause (KC7 of r22b), for comb.config.ts and the drizzle config alike (AD8 of
 * the area D review)
 */
export async function loadModule(file: string): Promise<{ default?: unknown }> {
	try {
		if (path.extname(file) === ".json") return { default: JSON.parse(fs.readFileSync(file, "utf8")) as unknown }
		/* keyed by its mtime, so a process that runs codegen again after the config changed reads the change */
		return (await import(`${pathToFileURL(file).href}?mtime=${fs.statSync(file).mtimeMs}`)) as { default?: unknown }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new CliError(`${file} failed to load: ${message}`, 1, { cause: error })
	}
}

/** The project's comb.config.ts (or .js), or undefined when it has none */
export async function findCombConfig(cwd: string): Promise<CodegenConfig | undefined> {
	for (const name of ["comb.config.ts", "comb.config.js"]) {
		const fp = path.resolve(cwd, name)
		if (fs.existsSync(fp)) {
			const mod = await loadModule(fp)
			return parsed(fp, mod.default ?? { ...mod })
		}
	}
	return undefined
}

export async function loadCombConfig(cwd: string): Promise<CodegenConfig> {
	const config = await findCombConfig(cwd)
	if (config) return config
	throw new CliError("No comb.config.ts found. Create one or use --tables <path> for direct mode.")
}

/** The database `name` declares, or a CliError naming the ones it does, and `hint` when the caller has one */
export function databaseIn(config: CodegenConfig, name: string, hint?: string): DatabaseCodegen {
	if (Object.hasOwn(config.databases, name)) return config.databases[name] as DatabaseCodegen
	throw new CliError(
		`comb.config.ts declares no database "${name}". Available: ${Object.keys(config.databases).join(", ")}${hint === undefined ? "" : `. ${hint}`}`,
	)
}

/** The tables file `tables` names, resolved against `cwd`; a CliError when it is missing */
export function tablesFile(cwd: string, tables: string): string {
	const resolved = path.resolve(cwd, tables)
	if (!fs.existsSync(resolved)) throw new CliError(`Tables file not found: ${resolved}`)
	return resolved
}

/** A database comb.config.ts declares FTS on: its tables file and the FTS of each table */
export type DeclaredFts = { fts: Record<string, FtsTableConfig>; tables: string }

/**
 * The FTS the database `name` declares in comb.config.ts, which a SQLite diff builds from its tables
 * file (KC3 of r22). No config, no database name, or no fts on the database declares none; a name
 * the config lacks is refused with `hint`.
 */
export async function declaredFts(
	cwd: string,
	{ hint, name }: { hint?: string | undefined; name: string | undefined },
): Promise<DeclaredFts | undefined> {
	const config = await findCombConfig(cwd)
	if (!config || name === undefined) return undefined
	const { fts, tables } = databaseIn(config, name, hint)
	return fts === undefined || Object.keys(fts).length === 0 ? undefined : { fts, tables }
}

/** The FTS5 DDL `declared` asks for, for the migration diff to keep apart from what Atlas sees */
export async function ftsSql(cwd: string, declared: DeclaredFts, io: CliIo): Promise<string> {
	const resolvedTables = tablesFile(cwd, declared.tables)
	const { analyze } = await import("../codegen/analyzer.ts")
	const { generateFtsSql } = await import("../codegen/generators/fts-sql.ts")
	return generateFtsSql((await analyze(resolvedTables, { cwd })).tables, declared.fts, io.err)
}
