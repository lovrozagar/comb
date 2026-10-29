/** One entity's generated file: its four DTO schemas, the entity stamp and the inferred types. */
import type { CombEntityMetaInput } from "../../../meta.ts"
import type { ImportRef } from "../../analyzer-types.ts"
import { propertyName, snakeToCamel, snakeToPascal } from "../../utils/case.ts"
import { byCodeUnit } from "../../utils/order.ts"
import type { FieldInfo, SchemaType, SharedSchema, TableInfo } from "./dto-types.ts"
import { BASE_TYPE_ALIASES, rewriteWithShared } from "./shared-schemas.ts"
import { comboFields, comboOf, type TimestampCombo, timestampNames } from "./timestamps.ts"
import { type ImportStyle, specifierFor, styled } from "../../utils/paths.ts"

export const SUFFIX: Record<SchemaType, string> = {
	create: "DtoCreate",
	read: "DtoRead",
	readPartial: "DtoReadPartial",
	update: "DtoUpdate",
}

const SCHEMA_TYPES: SchemaType[] = ["read", "readPartial", "create", "update"]

/* the update body has no timestamp spread: timestamps are not written by a caller */
/* the schema types a timestamp spread fills: what is read back; a create or update body takes none (F4) */
const SPREAD: Partial<Record<SchemaType, string>> = { read: "Read", readPartial: "ReadPartial" }

export type EntityFileOptions = {
	/** the directory the entity file is written to; schema imports are relative to it */
	entityDir: string
	filePrefix?: string | undefined
	metaImportFrom?: string | undefined
	/** how the consumer takes a relative import (F53) */
	importStyle?: ImportStyle | undefined
	/** the names the entity's schemas use, with where the tables file gets them */
	schemaImports: ImportRef[]
	sharedSchemas: Map<string, SharedSchema>
}

const list = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`
const nullable = (value: string | null) => (value === null ? "null" : JSON.stringify(value))

/** Render the published state subset, or `null`. */
function renderStates(states: CombEntityMetaInput["states"]): string {
	if (states === null) return "null"
	return [
		"{",
		`\t\tcolumn: ${JSON.stringify(states.column)},`,
		`\t\tinitial: ${nullable(states.initial)},`,
		`\t\tterminal: ${list(states.terminal)},`,
		`\t\tvalues: ${list(states.values)},`,
		"\t}",
	].join("\n")
}

/** Serialize `deriveEntityMeta`'s uniqueIndexes; do not rebuild the list here. */
function renderUniqueIndexes(indexes: CombEntityMetaInput["uniqueIndexes"]): string {
	if (indexes.length === 0) return "[]"
	return `[${indexes.map((idx) => `{ columns: ${list(idx.columns)}, name: ${JSON.stringify(idx.name)} }`).join(", ")}]`
}

/** Serialize `deriveEntityMeta`'s partialUniqueIndexes, each with its predicate (C7) */
function renderPartialUniqueIndexes(indexes: CombEntityMetaInput["partialUniqueIndexes"] = []): string {
	if (indexes.length === 0) return "[]"
	return `[${indexes.map((idx) => `{ columns: ${list(idx.columns)}, name: ${JSON.stringify(idx.name)}, where: ${JSON.stringify(idx.where)} }`).join(", ")}]`
}

/**
 * Render entity facts as a TypeScript object literal. Keys are emitted in a fixed order so
 * regenerating an unchanged table produces an identical file and the checksum header stays put.
 */
function renderCombMeta(meta: CombEntityMetaInput): string {
	return [
		"{",
		`\tgenerated: ${list(meta.generated)},`,
		`\tidentity: ${JSON.stringify(meta.identity)},`,
		`\timmutable: ${list(meta.immutable)},`,
		`\tkind: "entity",`,
		`\tname: ${JSON.stringify(meta.name)},`,
		`\tpartialUniqueIndexes: ${renderPartialUniqueIndexes(meta.partialUniqueIndexes)},`,
		`\tsoftDelete: ${nullable(meta.softDelete)},`,
		`\tstates: ${renderStates(meta.states)},`,
		`\ttenantColumn: ${nullable(meta.tenantColumn)},`,
		`\tuniqueIndexes: ${renderUniqueIndexes(meta.uniqueIndexes)},`,
		"}",
	].join("\n")
}

/** The specifier the generated file imports `ref` by: relative to it for a project file, in `style`, as written for a package. */
const specifierOf = (ref: ImportRef, entityDir: string, style: ImportStyle | undefined): string =>
	ref.path === null ? ref.from : specifierFor(entityDir, ref.path, style)

/** Import lines for the names an entity's schemas use, one per module, in a stable order. */
export function schemaImportLines(refs: ImportRef[], entityDir: string, style?: ImportStyle | undefined): string[] {
	const byModule = new Map<string, ImportRef[]>()
	for (const ref of refs) {
		const specifier = specifierOf(ref, entityDir, style)
		byModule.set(specifier, [...(byModule.get(specifier) ?? []), ref])
	}
	return [...byModule.entries()]
		.sort(([a], [b]) => byCodeUnit(a, b))
		.flatMap(([specifier, group]) => {
			const named = group
				.filter((r) => r.imported !== "*" && r.imported !== "default")
				.map((r) => (r.imported === r.name ? r.name : `${r.imported} as ${r.name}`))
				.sort()
			const lines = group.filter((r) => r.imported === "*").map((r) => `import * as ${r.name} from "${specifier}"`)
			lines.push(...group.filter((r) => r.imported === "default").map((r) => `import ${r.name} from "${specifier}"`))
			if (named.length > 0) lines.push(`import { ${[...new Set(named)].join(", ")} } from "${specifier}"`)
			return lines
		})
}

type Spread = { combo: TimestampCombo | null; keys: Set<string>; suffix: string }

function spreadOf(table: TableInfo): Spread {
	const combo = comboOf(table)
	const names = timestampNames(table.timestampStyle === "snake_case" ? "snake_case" : "camelCase")
	const keys = new Set(combo === null ? [] : comboFields(combo, names).map((f) => f.name))
	return { combo, keys, suffix: names.suffix }
}

const spreadName = (spread: Spread, type: SchemaType) =>
	spread.combo === null || SPREAD[type] === undefined
		? null
		: `timestamps${spread.combo}${SPREAD[type]}${spread.suffix}`

/* the fields the schemas spell out: all but those a timestamp spread provides in that schema type */
const ownFields = (table: TableInfo, spread: Spread) =>
	table.fields.filter((f) => spreadName(spread, f.type) === null || !spread.keys.has(f.key))

/** Every name the entity takes from `_shared`. */
function sharedImports(table: TableInfo, spread: Spread, shared: Map<string, SharedSchema>): string[] {
	const names = table.needsSharedMeta ? ["_m"] : []
	if (spread.combo !== null)
		names.push(...["Read", "ReadPartial"].map((v) => `timestamps${spread.combo}${v}${spread.suffix}`))
	for (const field of ownFields(table, spread)) {
		const sharedName = shared.get(field.zodType)?.name
		if (sharedName !== undefined) {
			names.push(sharedName)
			continue
		}
		for (const name of ["timestampSchema", "cidrSchema"]) if (field.zodType.includes(name)) names.push(name)
		const resolved = rewriteWithShared(field.zodType, shared)
		names.push(...(resolved.match(/_z_[0-9a-f]{8,16}/g) ?? []))
		const alias = BASE_TYPE_ALIASES.find(([, a]) => resolved.startsWith(a))?.[1]
		if (alias !== undefined) names.push(alias)
	}
	return [...new Set(names)].sort()
}

/** Local consts for inline schemas the entity uses 2+ times. */
function localConsts(table: TableInfo, spread: Spread, shared: Map<string, SharedSchema>): Map<string, string> {
	const counts = new Map<string, number>()
	for (const field of ownFields(table, spread)) {
		if (!shared.has(field.zodType)) counts.set(field.zodType, (counts.get(field.zodType) ?? 0) + 1)
	}
	const locals = new Map<string, string>()
	for (const [zodType, count] of counts) if (count >= 2) locals.set(zodType, `_l${locals.size}`)
	return locals
}

type Emit = { locals: Map<string, string>; shared: Map<string, SharedSchema>; spread: Spread; table: TableInfo }

function fieldLine(field: FieldInfo, { locals, shared }: Emit): string {
	const value = locals.get(field.zodType) ?? shared.get(field.zodType)?.name ?? rewriteWithShared(field.zodType, shared)
	return `\t${propertyName(field.key)}: ${value},`
}

function schemaLines(type: SchemaType, emit: Emit): string[] {
	const { spread, table } = emit
	if (!table.fields.some((f) => f.type === type)) return []
	const spreadAs = spreadName(spread, type)
	const fields = ownFields(table, spread).filter((f) => f.type === type)
	/* Entity facts ride on the read schema — the one a response is validated against — so a
	   consumer reads them off the same object. docs/meta-contract.md */
	const close = type === "read" && table.combMeta ? `}).meta(combMeta(${renderCombMeta(table.combMeta)}))` : "})"
	return [
		`export const ${snakeToCamel(table.name)}${SUFFIX[type]}Schema = z.object({`,
		...(spreadAs === null ? [] : [`\t...${spreadAs},`]),
		...fields.map((f) => fieldLine(f, emit)),
		close,
		"",
	]
}

function typeLines(table: TableInfo): string[] {
	const present = SCHEMA_TYPES.filter((type) => table.fields.some((f) => f.type === type))
	return [
		"/* TypeScript types */",
		...present.map(
			(type) =>
				`export type ${snakeToPascal(table.name)}${SUFFIX[type]} = z.infer<typeof ${snakeToCamel(table.name)}${SUFFIX[type]}Schema>`,
		),
		"",
	]
}

function importLines(table: TableInfo, spread: Spread, options: EntityFileOptions): string[] {
	const lines = [`import * as z from "zod"`]
	if (table.combMeta) lines.push(`import { combMeta } from "${options.metaImportFrom ?? "@lovrozagar/comb/meta"}"`)
	lines.push(...schemaImportLines(options.schemaImports, options.entityDir, options.importStyle))
	const shared = sharedImports(table, spread, options.sharedSchemas)
	if (shared.length > 0) {
		const sharedFile = options.filePrefix ? `../_shared/${options.filePrefix}._shared.gen` : "../_shared/index.gen"
		const from = styled(sharedFile, options.importStyle)
		lines.push(`import { ${shared.join(", ")} } from "${from}"`)
	}
	return [...lines, ""]
}

/** Every name `table`'s generated file takes from `_shared` */
export const sharedImportsOf = (table: TableInfo, shared: Map<string, SharedSchema>): string[] =>
	sharedImports(table, spreadOf(table), shared)

/**
 * Generate entity file content
 */
export function generateEntityFile(table: TableInfo, options: EntityFileOptions): string {
	const spread = spreadOf(table)
	const locals = localConsts(table, spread, options.sharedSchemas)
	const emit: Emit = { locals, shared: options.sharedSchemas, spread, table }
	const localLines = [...locals].map(
		([zodType, name]) => `const ${name} = ${rewriteWithShared(zodType, options.sharedSchemas)}`,
	)
	return [
		...importLines(table, spread, options),
		...localLines,
		...(localLines.length > 0 ? [""] : []),
		...SCHEMA_TYPES.flatMap((type) => schemaLines(type, emit)),
		...typeLines(table),
	].join("\n")
}
