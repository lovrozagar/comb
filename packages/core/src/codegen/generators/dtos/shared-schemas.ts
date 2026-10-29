/**
 * Cross-entity dedup: Zod expressions repeated across entities become one constant in
 * `_shared`, and every entity references it.
 */
import { createHash } from "node:crypto"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { SharedSchema, TableInfo } from "./dto-types.ts"
import { byCodeUnit } from "../../utils/order.ts"

/**
 * Base Zod type aliases — each constructor called once in shared, everything chains on it.
 * Order matters: longer prefixes first to avoid partial matches.
 */
export const BASE_TYPE_ALIASES: Array<[string, string]> = [
	["z.number().int().nonnegative()", "_intNN"],
	["z.number().int()", "_int"],
	["z.number()", "_num"],
	["z.string()", "_str"],
	["z.boolean()", "_bool"],
	["z.email()", "_eml"],
	["z.url()", "_url"],
]

/** Replace z.string() → _str, z.number().int() → _int, etc. in a zodType string */
export function rewriteBaseTypes(zodType: string): string {
	const alias = BASE_TYPE_ALIASES.find(([from]) => zodType.startsWith(from))
	return alias === undefined ? zodType : alias[1] + zodType.slice(alias[0].length)
}

/** `zodType` split into its layers: the base, then `.nullable()`, then `.optional()`. */
function layersOf(zodType: string): { base: string; nullable: string; optional: string } {
	const optional = zodType.endsWith(".optional()") ? ".optional()" : ""
	const rest = zodType.slice(0, zodType.length - optional.length)
	const nullable = rest.endsWith(".nullable()") ? ".nullable()" : ""
	return { base: rest.slice(0, rest.length - nullable.length), nullable, optional }
}

/**
 * A zodType split into its core and the `.meta(...)` that ends it; the whole zodType and no meta
 * when it ends otherwise, as an array whose elements carry the meta does: the last `.meta(` in it
 * is then inside the expression, and cutting there would leave a broken one
 */
function stripMeta(zodType: string): [string, string] {
	const metaIdx = zodType.lastIndexOf(".meta(")
	if (metaIdx === -1) return [zodType, ""]
	let depth = 0
	for (let i = metaIdx + 5; i < zodType.length; i++) {
		depth += zodType[i] === "(" ? 1 : zodType[i] === ")" ? -1 : 0
		if (depth === 0)
			return i === zodType.length - 1 ? [zodType.slice(0, metaIdx), zodType.slice(metaIdx)] : [zodType, ""]
	}
	return [zodType, ""]
}

/** Whether `zodType` names none of the identifiers the shared file cannot import (enum consts, schemas). */
function canBeShared(zodType: string, external: ReadonlySet<string>): boolean {
	return [...external].every((id) => !new RegExp(`(?<![\\w$.])${id.replace(/[$]/g, "\\$")}(?![\\w$])`).test(zodType))
}

type Usage = { counts: Map<string, number> }

/** How often each shareable zodType occurs: the shared file's use counts */
function usageOf(tables: TableInfo[], external: ReadonlySet<string>): Usage {
	const usage: Usage = { counts: new Map() }
	for (const table of tables) {
		for (const { zodType } of table.fields) {
			if (canBeShared(zodType, external)) usage.counts.set(zodType, (usage.counts.get(zodType) ?? 0) + 1)
		}
	}
	return usage
}

/**
 * The structural core of every base a field uses, its `.meta()` stripped, that is more than a name
 * the shared file already holds (`_str`, `timestampSchema`). Each is shared by its own code alone,
 * never by how often tables use it, so a table's file depends only on its own columns (F59), and a
 * field's own meta, an id's prefixed example among them, stays inline in its table's file. In
 * code-unit order, so the shared file's order is its content's too.
 */
function sharedCores(usage: Usage): string[] {
	const cores = new Set([...usage.counts.keys()].map((zodType) => stripMeta(layersOf(zodType).base)[0]))
	return [...cores].filter((core) => !/^[\w$]+$/.test(rewriteBaseTypes(core))).sort(byCodeUnit)
}

const digestOf = (zodType: string) => createHash("sha256").update(zodType).digest("hex")

/**
 * Emits each shared schema under a name its own code gives, `_z_<8 hex>`, so adding a column to
 * one table renames nothing another table's file uses (F35). Schemas whose 8 hex digits collide
 * (`colliding`, read from every schema the run names) each take 16, whichever is added first.
 */
class SharedNames {
	readonly result = new Map<string, SharedSchema>()
	/* a field and its assignment, no parameter property, so a consumer's erasableSyntaxOnly takes the file (K18 of r17) */
	private readonly colliding: ReadonlySet<string>

	constructor(colliding: ReadonlySet<string> = new Set()) {
		this.colliding = colliding
	}

	add(zodType: string, code: string, count: number): string {
		const digest = digestOf(zodType)
		const short = digest.slice(0, 8)
		const name = `_z_${this.colliding.has(short) ? digest.slice(0, 16) : short}`
		this.result.set(zodType, { code, count, name })
		return name
	}
}

/** The 8-hex prefixes two or more of `zodTypes` share */
function collidingPrefixes(zodTypes: Iterable<string>): Set<string> {
	const seen = new Set<string>()
	const out = new Set<string>()
	for (const zodType of zodTypes) {
		const short = digestOf(zodType).slice(0, 8)
		if (seen.has(short)) out.add(short)
		seen.add(short)
	}
	return out
}

/** A shared base and its variants: `.nullable()`, `.nullable().optional()`, `.optional()`. */
function addVariants(names: SharedNames, base: string, counts: Map<string, number>): void {
	const count = (zodType: string) => counts.get(zodType) ?? 0
	const baseName = names.add(base, rewriteBaseTypes(base), count(base))
	const nullable = `${base}.nullable()`
	const nullableOptional = `${base}.nullable().optional()`
	if (count(nullable) > 0 || count(nullableOptional) > 0) {
		const nullableName = names.add(nullable, `${baseName}.nullable()`, count(nullable))
		if (count(nullableOptional) > 0) names.add(nullableOptional, `${nullableName}.optional()`, count(nullableOptional))
	}
	const optional = `${base}.optional()`
	if (count(optional) > 0) names.add(optional, `${baseName}.optional()`, count(optional))
}

/**
 * Pass 2: compositional dedup.
 * Decomposes zodTypes into base + .nullable() + .optional() wrappers.
 * Shared base schemas get one constant, variants chain on top: `_z0.nullable()`.
 */
export function buildSharedSchemas(tables: TableInfo[], imports: ImportsMeta): Map<string, SharedSchema> {
	const external = new Set<string>([...imports.enumImports.keys(), ...imports.jsonSchemaImports])
	const usage = usageOf(tables, external)
	/* which schemas are shared turns on their use, never on their names: a first pass collects them,
	   so a colliding pair is named alike in any order */
	const run = (names: SharedNames) => {
		for (const core of sharedCores(usage)) addVariants(names, core, usage.counts)
		return names.result
	}
	return run(new SharedNames(collidingPrefixes(run(new SharedNames()).keys())))
}

/**
 * Rewrite an inline zodType to reference shared _z* constants where possible.
 * Decomposes into core + .meta() + .nullable() + .optional(), then checks if
 * the core (or core+meta, or core+meta+nullable) matches a shared constant.
 */
export function rewriteWithShared(zodType: string, sharedSchemas: Map<string, SharedSchema>): string {
	const full = sharedSchemas.get(zodType)
	if (full) return full.name
	const { base, nullable, optional } = layersOf(zodType)
	const withNullable = sharedSchemas.get(base + nullable)
	if (withNullable) return withNullable.name + optional
	const shared = sharedSchemas.get(base)
	if (shared) return shared.name + nullable + optional
	const [core, meta] = stripMeta(base)
	const sharedCore = meta ? sharedSchemas.get(core) : undefined
	if (sharedCore) return sharedCore.name + meta + nullable + optional
	return rewriteBaseTypes(zodType)
}
