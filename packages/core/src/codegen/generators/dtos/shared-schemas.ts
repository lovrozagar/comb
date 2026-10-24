/**
 * Cross-entity dedup: Zod expressions repeated across entities become one constant in
 * `_shared`, and every entity references it.
 */
import { createHash } from "node:crypto"
import type { ImportsMeta } from "../../analyzer-types.ts"
import type { SharedSchema, TableInfo } from "./dto-types.ts"

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

/** Strip trailing .meta(...) from a zodType, returning [core, metaSuffix] */
function stripMeta(zodType: string): [string, string] {
	const metaIdx = zodType.lastIndexOf(".meta(")
	if (metaIdx === -1) return [zodType, ""]
	let depth = 0
	for (let i = metaIdx + 5; i < zodType.length; i++) {
		depth += zodType[i] === "(" ? 1 : zodType[i] === ")" ? -1 : 0
		if (depth === 0) return [zodType.slice(0, metaIdx), zodType.slice(metaIdx, i + 1)]
	}
	return [zodType, ""]
}

/** Whether `zodType` names none of the identifiers the shared file cannot import (enum consts, schemas). */
function canBeShared(zodType: string, external: ReadonlySet<string>): boolean {
	return [...external].every((id) => !new RegExp(`(?<![\\w$.])${id.replace(/[$]/g, "\\$")}(?![\\w$])`).test(zodType))
}

type Usage = { counts: Map<string, number>; tablesOf: Map<string, Set<string>> }

/** How often each shareable zodType occurs, and in which tables. */
function usageOf(tables: TableInfo[], external: ReadonlySet<string>): Usage {
	const usage: Usage = { counts: new Map(), tablesOf: new Map() }
	for (const table of tables) {
		for (const { zodType } of table.fields) {
			if (!canBeShared(zodType, external)) continue
			usage.counts.set(zodType, (usage.counts.get(zodType) ?? 0) + 1)
			usage.tablesOf.set(zodType, (usage.tablesOf.get(zodType) ?? new Set()).add(table.name))
		}
	}
	return usage
}

/* Threshold: base total >= 3, OR base in 2+ tables with total >= 2; most used first */
function sharedBases(usage: Usage): string[] {
	const groups = new Map<string, { tables: Set<string>; total: number }>()
	for (const [zodType, count] of usage.counts) {
		const { base } = layersOf(zodType)
		const group = groups.get(base) ?? { tables: new Set<string>(), total: 0 }
		group.total += count
		for (const table of usage.tablesOf.get(zodType) as Set<string>) group.tables.add(table)
		groups.set(base, group)
	}
	return [...groups.entries()]
		.filter(([, g]) => g.total >= 3 || (g.tables.size >= 2 && g.total >= 2))
		.sort((a, b) => b[1].total - a[1].total)
		.map(([base]) => base)
}

const digestOf = (zodType: string) => createHash("sha256").update(zodType).digest("hex")

/**
 * Emits each shared schema under a name its own code gives, `_z_<8 hex>`, so adding a column to
 * one table renames nothing another table's file uses (F35). Schemas whose 8 hex digits collide
 * (`colliding`, read from every schema the run names) each take 16, whichever is added first.
 */
class SharedNames {
	readonly result = new Map<string, SharedSchema>()

	constructor(private readonly colliding: ReadonlySet<string> = new Set()) {}

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

/* structural cores (base with .meta stripped) used across 2+ tables, so entities can chain their own .meta */
function addCores(names: SharedNames, tables: TableInfo[], external: ReadonlySet<string>): void {
	const coreTables = new Map<string, Set<string>>()
	for (const table of tables) {
		for (const { zodType } of table.fields) {
			if (!canBeShared(zodType, external)) continue
			const { base } = layersOf(zodType)
			const [core, meta] = stripMeta(base)
			if (meta && !names.result.has(core)) coreTables.set(core, (coreTables.get(core) ?? new Set()).add(table.name))
		}
	}
	for (const [core, set] of coreTables) if (set.size >= 2) names.add(core, rewriteBaseTypes(core), 0)
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
		for (const base of sharedBases(usage)) addVariants(names, base, usage.counts)
		addCores(names, tables, external)
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
