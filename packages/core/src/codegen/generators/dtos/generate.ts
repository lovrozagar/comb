/**
 * DTO schema generator — pure transformer from AnalysisResult.
 *
 * Generates Zod schemas for read, readPartial, create, and update operations
 */
import fs from "node:fs"
import path from "node:path"
import type { ImportRef, TableMeta } from "../../analyzer-types.ts"
import { deriveEntityMeta } from "../../entity-meta.ts"
import { subpathName } from "../../utils/case.ts"
import { writeGenFile } from "../../utils/fs.ts"
import type { GeneratorContext } from "../context-types.ts"
import type { DtosConfig, FieldInfo, SchemaType, SharedSchema, TableInfo } from "./dto-types.ts"
import { generateEntityFile, sharedImportsOf } from "./entity-file.ts"
import { generateExampleMeta } from "./example-meta.ts"
import { fieldSchemaOf } from "./field-schema.ts"
import { updatePackageJson } from "./package-exports.ts"
import { aliasSchemaImports } from "./schema-aliases.ts"
import { buildSharedSchemas } from "./shared-schemas.ts"
import { collectUsedTimestampCombos, generateSharedFile } from "./timestamps.ts"

const SCHEMA_TYPES: SchemaType[] = ["read", "readPartial", "create", "update"]

/** The fields of every schema type a table's columns produce. */
function fieldInfosOf(meta: TableMeta, ctx: GeneratorContext): FieldInfo[] {
	const fields: FieldInfo[] = []
	for (const field of meta.fields) {
		for (const type of SCHEMA_TYPES) {
			const schema = fieldSchemaOf(field, type, { dialect: ctx.dialect, imports: ctx.analysis.imports })
			if (schema !== null) fields.push({ key: field.name, type, uses: schema.uses, zodType: schema.code })
		}
	}
	return fields
}

function tableInfoOf(meta: TableMeta, ctx: GeneratorContext): TableInfo {
	return {
		/* the stamp reads the rule fieldSchemaOf drops a write field by, writesOf, so it states what the DTOs take */
		combMeta: deriveEntityMeta(meta),
		fields: fieldInfosOf(meta, ctx),
		hasTimestamps: {
			createdAt: meta.timestamps.createdAt,
			deletedAt: meta.timestamps.deletedAt,
			updatedAt: meta.timestamps.updatedAt,
		},
		name: meta.varName,
		needsSharedMeta: meta.fields.some((field) => generateExampleMeta(field)?.needsSharedMeta === true),
		timestampStyle: meta.timestamps.style,
	}
}

/* the same name can be used by several columns; the generated file imports it once */
function schemaImportsOf(meta: TableMeta): ImportRef[] {
	const byName = new Map(meta.fields.flatMap((field) => field.schemaImports).map((ref) => [ref.name, ref]))
	return [...byName.values()]
}

type Written = { outputDir: string; sharedSchemas: Map<string, SharedSchema>; tables: TableInfo[] }

function writeShared(written: Written, config: DtosConfig, ctx: GeneratorContext): void {
	const sharedDir = path.join(written.outputDir, "_shared")
	const imported = new Set(written.tables.flatMap((table) => sharedImportsOf(table, written.sharedSchemas)))
	const content = generateSharedFile(collectUsedTimestampCombos(written.tables), written.sharedSchemas, {
		combFrom: config.importFrom,
		imported,
	})
	const file = path.join(sharedDir, config.filePrefix ? `${config.filePrefix}._shared.gen.ts` : "index.gen.ts")
	writeGenFile(file, content, { generator: "comb", staged: ctx.staged })
	ctx.log(`Generated: ${path.relative(ctx.cwd, file)}`)
}

function writeEntities(written: Written, config: DtosConfig, ctx: GeneratorContext): void {
	const metas = new Map(ctx.analysis.tables.map((meta) => [meta.varName, meta]))
	for (const table of written.tables) {
		const kebabName = subpathName(table.name)
		const entityDir = path.join(written.outputDir, kebabName)
		const content = generateEntityFile(table, {
			entityDir,
			filePrefix: config.filePrefix,
			importStyle: ctx.importStyle,
			combFrom: config.importFrom,
			metaImportFrom: config.importFrom === undefined ? undefined : `${config.importFrom}/meta`,
			schemaImports: schemaImportsOf(metas.get(table.name) as TableMeta),
			sharedSchemas: written.sharedSchemas,
		})
		const file = path.join(entityDir, config.filePrefix ? `${config.filePrefix}.${kebabName}.gen.ts` : "index.gen.ts")
		writeGenFile(file, content, { generator: "comb", staged: ctx.staged })
		ctx.log(`Generated: ${path.relative(ctx.cwd, file)}`)
	}
}

/**
 * Generate DTO schemas from analyzed tables
 */
export function generateDtos(ctx: GeneratorContext, config: DtosConfig): void {
	/* each c.json schema under a name of its own in every file that imports it (F1, F2) */
	const named = { ...ctx, analysis: aliasSchemaImports(ctx.analysis, ctx.cwd) }
	const tables = named.analysis.tables.map((meta) => tableInfoOf(meta, named))
	/* Pass 2: auto-deduplicate repeated schemas across all entities */
	const sharedSchemas = buildSharedSchemas(tables, named.analysis.imports)
	const written: Written = { outputDir: path.resolve(named.cwd, config.output), sharedSchemas, tables }
	writeShared(written, config, named)
	writeEntities(written, config, named)
	if (config.updatePackageJson) {
		const packageJsonPath = path.join(named.cwd, "package.json")
		if (fs.existsSync(packageJsonPath)) {
			updatePackageJson(packageJsonPath, { config, ctx: named, entities: tables.map((t) => t.name) })
		} else {
			named.warn(`package.json not found at ${packageJsonPath}`)
		}
	}
	named.log(`\nGenerated ${tables.length} entity DTOs`)
}
