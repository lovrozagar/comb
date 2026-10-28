/** The `_shared` file: base aliases, example objects, timestamp schemas and their refinements. */
import type { SharedSchema, TableInfo } from "./dto-types.ts"
import { SHARED_META_KEYS, SHARED_META_VALUES, SHARED_SCHEMAS } from "./example-meta.ts"
import { BASE_TYPE_ALIASES, rewriteBaseTypes } from "./shared-schemas.ts"

export type TimestampCombo = "Created" | "CreatedUpdated" | "CreatedUpdatedDeleted"
export type TimestampStyle = Exclude<TableInfo["timestampStyle"], "mixed">
type UsedTimestampCombos = { camelCase: Set<TimestampCombo>; snakeCase: Set<TimestampCombo> }

/** A table's timestamp column names, under its casing, and the suffix its shared spreads carry. */
export type TimestampNames = { created: string; deleted: string; suffix: string; updated: string }

export function timestampNames(style: TimestampStyle): TimestampNames {
	return style === "snake_case"
		? { created: "created_at", deleted: "deleted_at", suffix: "SnakeCase", updated: "updated_at" }
		: { created: "createdAt", deleted: "deletedAt", suffix: "", updated: "updatedAt" }
}

/**
 * The shared spread a table's timestamps use; none for a table without `created`, or one whose
 * timestamps mix casings, as a spread names every column under one
 */
export function comboOf({
	hasTimestamps: has,
	timestampStyle,
}: Pick<TableInfo, "hasTimestamps" | "timestampStyle">): TimestampCombo | null {
	if (!has.createdAt || timestampStyle === "mixed") return null
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
		const combo = comboOf(table)
		if (combo !== null) (table.timestampStyle === "snake_case" ? result.snakeCase : result.camelCase).add(combo)
	}
	return result
}

/**
 * The read and readPartial spreads of one combo, using shared `_z*` timestamp schemas when they
 * exist. A create body takes no timestamp: the column factories fill them, so a client backdates no row.
 */
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
	return [...block("Read", "read"), ...block("ReadPartial", "wrapped")]
}

function timestampVariants(
	combos: Set<TimestampCombo>,
	style: TimestampStyle,
	shared: Map<string, SharedSchema>,
): string[] {
	return [...combos].flatMap((combo) => spreads(combo, timestampNames(style), shared))
}

/** A top-level export of the shared file: its name, and its lines with the comment above it */
type Block = { lines: string[]; name: string | null }

/** The shared file's lines, as blocks: each export with the comment and blank lines above it */
function blocksOf(lines: readonly string[]): Block[] {
	const blocks: Block[] = []
	let pending: string[] = []
	for (const line of lines) {
		const name = /^export const (\w+)/.exec(line)?.[1]
		const continues = /^[\t }]/.test(line) && blocks.length > 0 && pending.length === 0
		if (line.startsWith("import ")) blocks.push({ lines: [line], name: null })
		else if (name !== undefined) blocks.push({ lines: [...pending, line], name })
		else if (continues) blocks.at(-1)?.lines.push(line)
		else pending.push(line)
		if (name !== undefined || continues) pending = []
	}
	return [...blocks, { lines: pending, name: null }]
}

/** The blocks a generated DTO imports, and every block those name, in file order */
function keepImported(lines: readonly string[], imported: ReadonlySet<string>): string[] {
	const blocks = blocksOf(lines)
	const named = new Map(blocks.flatMap((block) => (block.name === null ? [] : [[block.name, block]])))
	const kept = new Set<string>()
	const visit = (name: string) => {
		const block = named.get(name)
		if (block === undefined || kept.has(name)) return
		kept.add(name)
		const code = block.lines.join("\n")
		for (const other of named.keys())
			if (other !== name && new RegExp(`\\b${other.replace("$", "\\$")}\\b`).test(code)) visit(other)
	}
	for (const name of imported) visit(name)
	return blocks.filter((block) => block.name === null || kept.has(block.name)).flatMap((block) => block.lines)
}

const ZOD_IMPORT = `import * as z from "zod"`

function header(): string[] {
	return [
		ZOD_IMPORT,
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
		"/** A Postgres cidr: an address, its prefix length, and no bit set past it (F50) */",
		'export const cidrSchema = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]).refine(isCidr, { message: "Must be a network with no bit set past its prefix length" })',
		"",
	]
}

/* what the shared file may take from comb: isCidr for a cidr, isStorableText for the text guard (G1) */
const COMB_NAMES = ["isCidr", "isStorableText"] as const

/**
 * The shared `_shared/index.gen.ts` content: the combos tables use, the deduped schemas, and of
 * those only what a generated DTO imports, with everything that names
 */
export function generateSharedFile(
	used: UsedTimestampCombos,
	sharedSchemas: Map<string, SharedSchema>,
	{ combFrom = "@lovrozagar/comb", imported }: { combFrom?: string | undefined; imported: ReadonlySet<string> },
): string {
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
	return withoutUnusedImports(keepImported(lines, imported), combFrom).join("\n")
}

/**
 * The lines without the zod import when nothing kept uses it, with comb's import of the names they
 * use, and an empty module when nothing is kept at all
 */
function withoutUnusedImports(lines: readonly string[], combFrom: string): readonly string[] {
	const uses = (pattern: RegExp) => lines.some((line) => line !== ZOD_IMPORT && pattern.test(line))
	const rest = lines.filter((line) => line !== ZOD_IMPORT || uses(/\bz\./))
	const named = COMB_NAMES.filter((name) => uses(new RegExp(`\\b${name}\\b`)))
	if (named.length > 0)
		rest.splice(rest.indexOf(ZOD_IMPORT) + 1, 0, `import { ${named.join(", ")} } from "${combFrom}"`)
	return rest.some((line) => line.trim() !== "") ? rest : ["export {}", ""]
}
