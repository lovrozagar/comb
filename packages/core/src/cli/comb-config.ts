/** comb.config.ts: the databases codegen and migrate diff read their tables and FTS from. */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import * as z from "zod"
import type { CodegenConfig, DatabaseCodegen } from "../codegen/config.ts"
import { codegenConfigSchema } from "../codegen/config-schema.ts"
import { CliError, type CliIo } from "./output.ts"

export type { CodegenConfig, DatabaseCodegen }

/** `exported`, the config file `file` exports, held to its schema; a CliError naming the file and each key that is wrong (K14) */
function parsed(file: string, exported: unknown): CodegenConfig {
	const result = codegenConfigSchema().safeParse(exported)
	if (result.success) return result.data
	throw new CliError(`${file} is not a valid comb config:\n${z.prettifyError(result.error)}`)
}

/** The project's comb.config.ts (or .js), or undefined when it has none */
export async function findCombConfig(cwd: string): Promise<CodegenConfig | undefined> {
	for (const name of ["comb.config.ts", "comb.config.js"]) {
		const fp = path.resolve(cwd, name)
		if (fs.existsSync(fp)) {
			/* keyed by its mtime, so a process that runs codegen again after the config changed reads the change */
			const url = `${pathToFileURL(fp).href}?mtime=${fs.statSync(fp).mtimeMs}`
			const mod = (await import(url)) as { default?: unknown }
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

/**
 * The FTS5 DDL a database's config declares, for the migration diff to keep apart from what Atlas
 * sees. No config, or a database without fts, has none; any other failure is the caller's to see.
 */
export async function configuredFtsSql(
	cwd: string,
	{ hint, name: dbName }: { hint?: string | undefined; name: string | undefined },
	io: CliIo,
): Promise<string | undefined> {
	const config = await findCombConfig(cwd)
	if (!config || dbName === undefined) return undefined
	const db = databaseIn(config, dbName, hint)
	if (!db.fts || Object.keys(db.fts).length === 0) return undefined
	const resolvedTables = tablesFile(cwd, db.tables)
	const { analyze } = await import("../codegen/analyzer.ts")
	const { generateFtsSql } = await import("../codegen/generators/fts-sql.ts")
	return generateFtsSql(analyze(resolvedTables, { cwd }).tables, db.fts, io.err)
}
