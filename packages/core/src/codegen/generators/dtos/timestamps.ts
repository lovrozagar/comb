/** The `_shared` file: base aliases, example objects, timestamp schemas and their refinements. */
import type { SharedSchema, TableInfo } from "./dto-types.ts"
import { SHARED_META_KEYS, SHARED_META_VALUES, SHARED_SCHEMAS } from "./example-meta.ts"
import { BASE_TYPE_ALIASES, rewriteBaseTypes } from "./shared-schemas.ts"

export type TimestampCombo = "Created" | "CreatedUpdated" | "CreatedUpdatedDeleted"
export type TimestampStyle = TableInfo["timestampStyle"]
type UsedTimestampCombos = { camelCase: Set<TimestampCombo>; snakeCase: Set<TimestampCombo> }

/** A table's timestamp column names, under its casing, and the suffix its shared spreads carry. */
export type TimestampNames = { created: string; deleted: string; suffix: string; updated: string }

export function timestampNames(style: TimestampStyle): TimestampNames {
	return style === "snake_case"
		? { created: "created_at", deleted: "deleted_at", suffix: "SnakeCase", updated: "updated_at" }
		: { created: "createdAt", deleted: "deletedAt", suffix: "", updated: "updatedAt" }
}

/** The shared spread a table's timestamps use; a table without `created` has none. */
export function comboOf(has: TableInfo["hasTimestamps"]): TimestampCombo | null {
	if (!has.createdAt) return null
	if (has.updatedAt && has.deletedAt) return "CreatedUpdatedDeleted"
	return has.updatedAt ? "CreatedUpdated" : "Created"
}

/** The columns a combo's spread holds, in emitted order. */
export function comboFields(combo: TimestampCombo, names: TimestampNames): { name: string; nullable: boolean }[] {
	const created = { name: names.created, nullable: false }
	const updated = { name: names.updated, nullable: false }
	if (combo === "Created") return [created]
	if (combo === "CreatedUpdated") return [created, updated]
	return [created, { name: names.deleted, nullable: true }, updated]
}

/**
 * Analyze tables to determine which timestamp combos are actually used
 */
export function collectUsedTimestampCombos(tables: TableInfo[]): UsedTimestampCombos {
	const result: UsedTimestampCombos = { camelCase: new Set(), snakeCase: new Set() }
	for (const table of tables) {
		const combo = comboOf(table.hasTimestamps)
		if (combo !== null) (table.timestampStyle === "snake_case" ? result.snakeCase : result.camelCase).add(combo)
	}
	return result
}

function validators(hasUpdated: boolean, hasDeleted: boolean, n: TimestampNames): string[] {
	const lines: string[] = []
	const { created: c, deleted: d, suffix, updated: u } = n
	if (hasUpdated) {
		lines.push(`export const validateTimestampsUpdatedAfterCreated${suffix} = (data: any) => data.${u} >= data.${c}`)
		lines.push(
			`export const validateTimestampsUpdatedAfterCreatedOptional${suffix} = (data: any) => !data.${u} || !data.${c} || data.${u} >= data.${c}`,
		)
	}
	if (hasDeleted) {
		lines.push(
			`export const validateTimestampsDeletedAfterCreated${suffix} = (data: any) => data.${d} === null || data.${d} >= data.${c}`,
		)
		lines.push(
			`export const validateTimestampsDeletedAfterCreatedOptional${suffix} = (data: any) => !data.${d} || !data.${c} || data.${d} >= data.${c}`,
		)
	}
	return lines
}

/* emitted only for a combo with updatedAt, which every combo with deletedAt also has */
function refinements(constName: string, deleted: boolean, n: TimestampNames): string[] {
	const entry = (key: string, column: string) => [
		`\t${key}: {`,
		`\t\tmessage: "${column} cannot be before ${n.created}",`,
		`\t\tpath: ["${column}"]`,
		"\t},",
	]
	return [
		`export const ${constName}${n.suffix} = {`,
		...(deleted ? entry("deletedAfterCreated", n.deleted) : []),
		...entry("updatedAfterCreated", n.updated),
		"}",
		"",
	]
}

/** The read, readPartial and create spreads of one combo, using shared `_z*` timestamp schemas when they exist. */
function spreads(combo: TimestampCombo, n: TimestampNames, shared: Map<string, SharedSchema>): string[] {
	const resolve = (zodType: string): string => shared.get(zodType)?.name ?? zodType
	const plain = { read: resolve("timestampSchema"), wrapped: resolve("timestampSchema.optional()") }
	const nullable = {
		read: resolve("timestampSchema.nullable()"),
		wrapped: resolve("timestampSchema.nullable().optional()"),
	}
	const fields = comboFields(combo, n)
	const block = (variant: string, pick: "read" | "wrapped") => [
		`export const timestamps${combo}${variant}${n.suffix} = {`,
		...fields.map((f) => `\t${f.name}: ${(f.nullable ? nullable : plain)[pick]},`),
		"}",
		"",
	]
	return [...block("Read", "read"), ...block("ReadPartial", "wrapped"), ...block("Create", "wrapped")]
}

function timestampVariants(
	combos: Set<TimestampCombo>,
	style: TimestampStyle,
	shared: Map<string, SharedSchema>,
): string[] {
	const n = timestampNames(style)
	const flags = {
		deleted: combos.has("CreatedUpdatedDeleted"),
		updated: combos.has("CreatedUpdated") || combos.has("CreatedUpdatedDeleted"),
	}
	const lines = validators(flags.updated, flags.deleted, n)
	if (flags.updated) {
		lines.push(
			"",
			...refinements("timestampsReadRefinements", flags.deleted, n),
			...refinements("timestampsOptionalRefinements", flags.deleted, n),
		)
	}
	for (const combo of combos) lines.push(...spreads(combo, n, shared))
	return lines
}

function header(): string[] {
	return [
		`import * as z from "zod"`,
		"",
		...BASE_TYPE_ALIASES.map(([expr, alias]) => `export const ${alias} = ${expr}`),
		"",
		"/** Shared meta example objects for OpenAPI — avoids repeated inline allocations */",
		"export const _m = {",
		...SHARED_META_KEYS.map((key) => `\t${key}: ${SHARED_META_VALUES[key]},`),
		"}",
		"",
		"/** Shared complete schemas — identical across all entities */",
		...Object.entries(SHARED_SCHEMAS).map(([name, schema]) => `export const _s_${name} = ${rewriteBaseTypes(schema)}`),
		"",
		"/** Base timestamp field - allows Unix epoch (0) */",
		`export const timestampSchema = ${rewriteBaseTypes("z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)")}.meta(_m.timestamp)`,
		"",
		"/** Nullable timestamp field */",
		"export const timestampNullableSchema = _intNN.max(Number.MAX_SAFE_INTEGER).nullable()",
		"",
	]
}

/**
 * Generate shared _shared/index.gen.ts content — only emits combos actually used
 */
export function generateSharedFile(used: UsedTimestampCombos, sharedSchemas: Map<string, SharedSchema>): string {
	const lines = header()
	/* Auto-deduped shared schema constants — must be before timestamp spreads that reference them */
	if (sharedSchemas.size > 0) {
		lines.push("/** Auto-deduped schemas — variants chain on shared bases */")
		for (const { code, count, name } of sharedSchemas.values()) {
			lines.push(`export const ${name} = ${code}${count > 0 ? ` /* ${count}x */` : ""}`)
		}
		lines.push("")
	}
	if (used.camelCase.size > 0) lines.push(...timestampVariants(used.camelCase, "camelCase", sharedSchemas))
	if (used.snakeCase.size > 0) lines.push(...timestampVariants(used.snakeCase, "snake_case", sharedSchemas))
	return lines.join("\n")
}
