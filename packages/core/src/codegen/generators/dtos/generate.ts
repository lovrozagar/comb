/**
 * DTO schema generator — pure transformer from AnalysisResult.
 *
 * Generates Zod schemas for read, readPartial, create, and update operations
 */
import fs from "node:fs"
import path from "node:path"
import type { ImportRef, TableMeta } from "../../analyzer-types.ts"
import { deriveEntityMeta, isExcludedFromUpdate } from "../../entity-meta.ts"
import { camelToKebab } from "../../utils/case.ts"
import { writeGenFile } from "../../utils/fs.ts"
import type { GeneratorContext } from "../context-types.ts"
import type { DtosConfig, FieldInfo, SchemaType, SharedSchema, TableInfo } from "./dto-types.ts"
import { generateEntityFile, sharedImportsOf } from "./entity-file.ts"
import { generateExampleMeta } from "./example-meta.ts"
import { generateFieldSchema } from "./field-schema.ts"
import { updatePackageJson } from "./package-exports.ts"
import { buildSharedSchemas } from "./shared-schemas.ts"
import { collectUsedTimestampCombos, generateSharedFile } from "./timestamps.ts"

const SCHEMA_TYPES: SchemaType[] = ["read", "readPartial", "create", "update"]

/** The fields of every schema type a table's columns produce. */
function fieldInfosOf(meta: TableMeta, ctx: GeneratorContext): FieldInfo[] {
	const fields: FieldInfo[] = []
	for (const field of meta.fields) {
		for (const type of SCHEMA_TYPES) {
			/* Shared with the published `immutable` list so the two cannot disagree */
			if (type === "update" && isExcludedFromUpdate(field)) continue
			const zodType = generateFieldSchema(field, type, { dialect: ctx.dialect, imports: ctx.analysis.imports })
			if (zodType !== null) fields.push({ key: field.name, type, zodType })
		}
	}
	return fields
}

function tableInfoOf(meta: TableMeta, ctx: GeneratorContext): TableInfo {
	const fields = fieldInfosOf(meta, ctx)
	/* The set the generator actually emitted — not a restatement of the rules that produced
	   it, so `immutable` cannot drift from the update DTO. */
	const updateFields = new Set(fields.filter((f) => f.type === "update").map((f) => f.key))
	return {
		combMeta: deriveEntityMeta(meta, updateFields),
		fields,
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
	const content = generateSharedFile(collectUsedTimestampCombos(written.tables), written.sharedSchemas, imported)
	const file = path.join(sharedDir, config.filePrefix ? `${config.filePrefix}._shared.gen.ts` : "index.gen.ts")
	writeGenFile(file, content, { generator: "comb", staged: ctx.staged })
	ctx.log(`Generated: ${path.relative(ctx.cwd, file)}`)
}

function writeEntities(written: Written, config: DtosConfig, ctx: GeneratorContext): void {
	const metas = new Map(ctx.analysis.tables.map((meta) => [meta.varName, meta]))
	for (const table of written.tables) {
		const kebabName = camelToKebab(table.name)
		const entityDir = path.join(written.outputDir, kebabName)
		const content = generateEntityFile(table, {
			entityDir,
			filePrefix: config.filePrefix,
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
	const tables = ctx.analysis.tables.map((meta) => tableInfoOf(meta, ctx))
	/* Pass 2: auto-deduplicate repeated schemas across all entities */
	const sharedSchemas = buildSharedSchemas(tables, ctx.analysis.imports)
	const written: Written = { outputDir: path.resolve(ctx.cwd, config.output), sharedSchemas, tables }
	writeShared(written, config, ctx)
	writeEntities(written, config, ctx)
	if (config.updatePackageJson) {
		const packageJsonPath = path.join(ctx.cwd, "package.json")
		if (fs.existsSync(packageJsonPath)) {
			updatePackageJson(packageJsonPath, { config, ctx, entities: tables.map((t) => t.name) })
		} else {
			ctx.warn(`package.json not found at ${packageJsonPath}`)
		}
	}
	ctx.log(`\nGenerated ${tables.length} entity DTOs`)
}
