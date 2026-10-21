/**
 * Generate DTOs from a tables source and import them, so tests assert on what the generated
 * schemas accept and reject, not on the text the generator printed. Output lands inside the
 * package (gitignored `.tmp-*`) so the emitted `zod` and `@lovrozagar/comb/*` imports resolve.
 */
import fs from "node:fs"
import path from "node:path"
import type * as z from "zod"
import { analyze } from "../../../src/codegen/analyzer.ts"
import { generateDtos } from "../../../src/codegen/generators/dtos/index.ts"
import { testContext } from "../../../src/codegen/generators/__fixtures__/context.ts"

const ROOT = path.resolve(import.meta.dirname, "../codegen/.tmp-dtos")

const HEAD = {
	postgres: `import { pgTable } from "drizzle-orm/pg-core"
import { c } from "@lovrozagar/comb/pg/columns"
`,
	sqlite: `import { sqliteTable } from "drizzle-orm/sqlite-core"
import { c } from "@lovrozagar/comb/sqlite/columns"
`,
}

export type GeneratedEntity = Record<string, z.ZodObject>

export type GenerateOptions = {
	/** the dialect the tables are written in and the DTOs generated for (default sqlite) */
	dialect?: "postgres" | "sqlite"
	/** further files beside the tables file, by name */
	files?: Record<string, string>
	/** the DTO output directory, relative to the tables file's directory */
	output?: string
}

/** The directory `generatedDtos(name, …)` writes its tables file and its `dtos` output in */
export const generatedDir = (name: string): string => path.join(ROOT, `${name}-${process.pid}`)

/** The generated module of every entity, by its kebab-case directory name. */
export async function generatedDtos(
	name: string,
	tables: string,
	options: GenerateOptions = {},
): Promise<Record<string, GeneratedEntity>> {
	const dir = generatedDir(name)
	fs.rmSync(dir, { force: true, recursive: true })
	fs.mkdirSync(dir, { recursive: true })
	for (const [file, source] of Object.entries(options.files ?? {})) fs.writeFileSync(path.join(dir, file), source)
	const tablesPath = path.join(dir, "db.x.tables.ts")
	const dialect = options.dialect ?? "sqlite"
	fs.writeFileSync(tablesPath, `${HEAD[dialect]}${tables}\n`)
	const output = path.join(dir, options.output ?? "dtos")
	generateDtos(testContext(analyze(tablesPath), { cwd: dir, dialect, tablesPath }), { output })
	const entities: Record<string, GeneratedEntity> = {}
	for (const entry of fs.readdirSync(output)) {
		if (entry === "_shared") continue
		entities[entry] = (await import(path.join(output, entry, "index.gen.ts"))) as GeneratedEntity
	}
	return entities
}

/** Remove everything `generatedDtos` wrote in this process. */
export function cleanGeneratedDtos(): void {
	if (!fs.existsSync(ROOT)) return
	for (const entry of fs.readdirSync(ROOT)) {
		if (entry.endsWith(`-${process.pid}`)) fs.rmSync(path.join(ROOT, entry), { force: true, recursive: true })
	}
}
