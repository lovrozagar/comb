/**
 * DTO schema generator — pure transformer from AnalysisResult.
 *
 * Generates Zod schemas for read, readPartial, create, and update operations
 */
import fs from "node:fs"
import path from "node:path"
import type { CombEntityMetaInput } from "../../meta.ts"
import type { AnalysisResult, FieldMeta, ImportsMeta } from "../analyzer-types.ts"
import type { FieldConstraints } from "../annotations.ts"
import { deriveEntityMeta, isExcludedFromUpdate } from "../entity-meta.ts"
import { camelToKebab, snakeToCamel, snakeToPascal } from "../utils/case.ts"
import { ensureDir, writeGenFile, writeJsonAtomic } from "../utils/fs.ts"
import { extractDbName } from "../utils/ts-morph.ts"

type SchemaType = "read" | "readPartial" | "create" | "update"

const schemaTypeToOutputSuffix: Record<SchemaType, string> = {
	create: "DtoCreate",
	read: "DtoRead",
	readPartial: "DtoReadPartial",
	update: "DtoUpdate",
}

type FieldInfo = {
	key: string
	type: SchemaType
	zodType: string
}

type TableInfo = {
	/** Entity facts stamped on the read schema; null when there is no single identity */
	combMeta: CombEntityMetaInput | null
	fields: FieldInfo[]
	hasTimestamps: {
		createdAt: boolean
		deletedAt: boolean
		updatedAt: boolean
	}
	name: string
	needsSharedMeta: boolean
	timestampStyle: "camelCase" | "snake_case"
	usedEnums: Set<string>
	usedJsonSchemas: Set<string>
}

type DtosConfig = {
	filePrefix?: string | undefined
	/** Package the generated meta stamp imports from. Matches EntitiesConfig. */
	importFrom?: string | undefined
	output: string
	updatePackageJson?: boolean
}

/**
 * Generate DTO schemas from analyzed tables
 */
export function generateDtos(analysis: AnalysisResult, tablesPath: string, config: DtosConfig, cwd: string): void {
	const absoluteOutputDir = path.resolve(cwd, config.output)

	/* Ensure output directories exist */
	const sharedDir = path.join(absoluteOutputDir, "_shared")
	ensureDir(sharedDir)

	const tables: TableInfo[] = []

	/* Transform TableMeta[] into TableInfo[] with zodType generation */
	for (const meta of analysis.tables) {
		const fields: FieldInfo[] = []
		const usedEnums = new Set<string>()
		const usedJsonSchemas = new Set<string>()
		let needsSharedMeta = false

		for (const field of meta.fields) {
			/* Track enum usage */
			if (field.enumName) {
				usedEnums.add(field.enumName)
			}

			/* Track JSON schema usage */
			if (field.jsonSchemaName) {
				usedJsonSchemas.add(field.jsonSchemaName)
			}

			/* Check if this field needs shared meta */
			const exampleResult = generateExampleMeta(field)
			if (exampleResult?.needsSharedMeta) {
				needsSharedMeta = true
			}

			/* Generate schemas for all types */
			const schemaTypes: SchemaType[] = ["read", "readPartial", "create", "update"]

			for (const schemaType of schemaTypes) {
				/* Skip based on schema type rules */
				if (schemaType === "create" && field.constraints.nomutate) continue
				/* Shared with the published `immutable` list so the two cannot disagree */
				if (schemaType === "update" && isExcludedFromUpdate(field)) continue

				const zodType = generateFieldSchema(field, schemaType, analysis.imports)
				if (zodType !== null) {
					fields.push({ key: field.name, type: schemaType, zodType })
				}
			}
		}

		/* The set the generator actually emitted — not a restatement of the rules
		   that produced it, so `immutable` cannot drift from the update DTO. */
		const updateFields = new Set(fields.filter((f) => f.type === "update").map((f) => f.key))

		tables.push({
			combMeta: deriveEntityMeta(meta, updateFields),
			fields,
			hasTimestamps: {
				createdAt: meta.timestamps.createdAt,
				deletedAt: meta.timestamps.deletedAt,
				updatedAt: meta.timestamps.updatedAt,
			},
			name: meta.varName,
			needsSharedMeta,
			timestampStyle: meta.timestamps.style,
			usedEnums,
			usedJsonSchemas,
		})
	}

	/* Collect which timestamp combos are actually used */
	const usedTimestampCombos = collectUsedTimestampCombos(tables)

	/* Pass 2: auto-deduplicate repeated schemas across all entities */
	const sharedSchemas = buildSharedSchemas(tables, analysis.imports)

	/* Write shared file — only emits combos actually used */
	const sharedContent = generateSharedFile(usedTimestampCombos, sharedSchemas)
	const sharedFileName = config.filePrefix ? `${config.filePrefix}._shared.gen.ts` : "index.gen.ts"
	const sharedFilePath = path.join(sharedDir, sharedFileName)
	writeGenFile(sharedFilePath, sharedContent, "comb")
	console.log(`Generated: ${path.relative(process.cwd(), sharedFilePath)}`)

	/* Calculate relative path from entity folders to json.schemas */
	const tablesBaseName = path.basename(tablesPath, ".ts")
	const jsonSchemasRelativePath = config.filePrefix
		? `../../${config.filePrefix}.json-schemas`
		: (() => {
				const dbPrefixMatch = tablesBaseName.match(/^db\.(\w+)\.tables$/)
				const dbPrefix = dbPrefixMatch ? dbPrefixMatch[1] : "core"
				return `../../db.${dbPrefix}.json.schemas`
			})()

	/* Write entity files */
	const enumImportPaths = new Map<string, Set<string>>()
	for (const [enumConstant, importPath] of analysis.imports.enumImports) {
		const existing = enumImportPaths.get(importPath) ?? new Set<string>()
		existing.add(enumConstant)
		enumImportPaths.set(importPath, existing)
	}

	for (const table of tables) {
		const kebabName = camelToKebab(table.name)
		const entityDir = path.join(absoluteOutputDir, kebabName)

		ensureDir(entityDir)

		const entityContent = generateEntityFile(
			table,
			enumImportPaths,
			jsonSchemasRelativePath,
			analysis.imports,
			sharedSchemas,
			config.filePrefix,
			config.importFrom === undefined ? undefined : `${config.importFrom}/meta`,
		)
		const entityFileName = config.filePrefix ? `${config.filePrefix}.${kebabName}.gen.ts` : "index.gen.ts"
		const entityFilePath = path.join(entityDir, entityFileName)
		writeGenFile(entityFilePath, entityContent, "comb")
		console.log(`Generated: ${path.relative(process.cwd(), entityFilePath)}`)
	}

	/* Update package.json if requested */
	if (config.updatePackageJson) {
		const packageJsonPath = path.join(cwd, "package.json")
		if (fs.existsSync(packageJsonPath)) {
			const entityNames = tables.map((t) => t.name)
			updatePackageJson(packageJsonPath, entityNames, config.output, tablesPath, cwd, config.filePrefix)
		} else {
			console.warn(`package.json not found at ${packageJsonPath}`)
		}
	}

	console.log(`\nGenerated ${tables.length} entity DTOs`)
}

/**
 * Extract and parse TypeScript types from $type<>
 */
function extractAndParseType(raw: string, jsonSchemaImports: Set<string>): string | null {
	const typeStart = raw.indexOf(".$type<")
	if (typeStart === -1) return null

	const startPos = typeStart + 7
	let angleCount = 1
	let endPos = startPos
	let inString = false
	let stringChar: string | null = null

	/* Find matching closing > accounting for strings */
	for (let i = startPos; i < raw.length; i++) {
		const char = raw[i]
		const prevChar = i > 0 ? raw[i - 1] : null

		/* Handle string literals */
		if ((char === '"' || char === "'") && prevChar !== "\\") {
			if (!inString) {
				inString = true
				stringChar = char
			} else if (char === stringChar) {
				inString = false
				stringChar = null
			}
		}

		if (!inString) {
			if (char === "<") angleCount++
			if (char === ">") angleCount--
			if (angleCount === 0) {
				endPos = i
				break
			}
		}
	}

	if (endPos <= startPos) return null

	let typeDefinition = raw.substring(startPos, endPos).trim()
	typeDefinition = typeDefinition.replace(/\s+/g, " ").replace(/\n/g, " ").trim()

	/* Check for z.infer<typeof schemaName> pattern */
	const inferPattern = /^z\.infer<typeof\s+(\w+)>$/
	const inferMatch = typeDefinition.match(inferPattern)

	if (inferMatch && inferMatch[1] !== undefined) {
		const schemaName = inferMatch[1]
		jsonSchemaImports.add(schemaName)
		return schemaName
	}

	/* Anything else is described by the column helper itself — the caller only
	   accepts a named schema, so there is nothing further to derive here. */
	return null
}

const EXAMPLE_ULID = "01h5a3g8k9m2n4p6q8r0t2v4x6"
const ALPHANUMERIC_CYCLE = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"

/**
 * Shared meta example keys emitted in _shared/index.gen.ts.
 * Entity files reference `_m.string` instead of inline `{ examples: ["string"] }`.
 */
const SHARED_META_KEYS = ["boolean", "email", "integer", "real", "serialId", "string", "timestamp", "url"] as const
type SharedMetaKey = (typeof SHARED_META_KEYS)[number]

const SHARED_META_VALUES: Record<SharedMetaKey, string> = {
	boolean: "{ examples: [true] }",
	email: `{ examples: ["user@example.com"] }`,
	integer: "{ examples: [42] }",
	real: "{ examples: [0.5] }",
	serialId: "{ examples: [1] }",
	string: `{ examples: ["string"] }`,
	timestamp: "{ examples: [1711468800000] }",
	url: `{ examples: ["https://example.com"] }`,
}

/**
 * Shared complete schemas emitted in _shared/index.gen.ts.
 * Identical schemas reused across all entities (no per-field constraints).
 */
const SHARED_SCHEMAS = {
	boolean: "z.boolean().meta(_m.boolean)",
	real: "z.number().meta(_m.real)",
} as const

type ExampleResult = {
	/** Code to append: `.meta(_m.string)` or `.meta({ examples: ["custom"] })` */
	code: string
	/** Shared import needed: "_m" for shared meta, specific schema name, or null */
	needsSharedMeta: boolean
}

/**
 * Generate .meta() reference based on schema type.
 * Prefers shared _m.* references over inline objects.
 */
function generateExampleMeta(field: FieldMeta): ExampleResult | null {
	const { constraints, raw } = field

	/* Skip sensitive and complex fields */
	if (constraints.private || constraints.password) return null
	if (/c\.ref[<(]/.test(raw) || field.foreignKey) return null
	if (/c\.json[<(]/.test(raw)) return null
	if (/c\.(createdAt|updatedAt|deletedAt|timestamp)[<(]/.test(raw)) return null

	/* Constraint-based — use shared meta refs */
	if (constraints.email) return { code: ".meta(_m.email)", needsSharedMeta: true }
	if (constraints.url) return { code: ".meta(_m.url)", needsSharedMeta: true }

	/* ID with prefix — unique per table, inline */
	if (/c\.id[<(]/.test(raw)) {
		const prefixMatch = raw.match(/c\.id\(["'](\w+)["']\)/)
		const prefix = prefixMatch?.[1] ?? "id"
		return { code: `.meta({ examples: ["${prefix}_${EXAMPLE_ULID}"] })`, needsSharedMeta: false }
	}

	/* Primitives — use shared meta refs */
	if (/c\.serialId[<(]/.test(raw)) return { code: ".meta(_m.serialId)", needsSharedMeta: true }
	if (/c\.boolean[<(]/.test(raw)) return { code: ".meta(_m.boolean)", needsSharedMeta: true }

	/* Enum with inline values — unique, inline */
	if (field.enumValues && field.enumValues.length > 0) {
		return { code: `.meta({ examples: ["${field.enumValues[0]}"] })`, needsSharedMeta: false }
	}

	/* Integer with min/max → midpoint (unique), else shared */
	if (/c\.integer[<(]/.test(raw)) {
		if (constraints.min !== null && constraints.max !== null) {
			const mid = Math.floor((constraints.min + constraints.max) / 2)
			if (mid === 42) return { code: ".meta(_m.integer)", needsSharedMeta: true }
			return { code: `.meta({ examples: [${mid}] })`, needsSharedMeta: false }
		}
		return { code: ".meta(_m.integer)", needsSharedMeta: true }
	}

	/* Real number — midpoint or shared */
	if (/c\.real[<(]/.test(raw)) {
		if (constraints.min !== null && constraints.max !== null) {
			const mid = (constraints.min + constraints.max) / 2
			if (mid === 0.5) return { code: ".meta(_m.real)", needsSharedMeta: true }
			return { code: `.meta({ examples: [${mid}] })`, needsSharedMeta: false }
		}
		return { code: ".meta(_m.real)", needsSharedMeta: true }
	}

	/* Text: exact-length — unique, inline */
	if (constraints.min !== null && constraints.max !== null && constraints.min === constraints.max) {
		const len = constraints.min
		const example = ALPHANUMERIC_CYCLE.slice(0, len)
		return { code: `.meta({ examples: ["${example}"] })`, needsSharedMeta: false }
	}

	/* Generic text fallback — shared */
	if (/c\.(text|id|enum)[<(]/.test(raw)) {
		return { code: ".meta(_m.string)", needsSharedMeta: true }
	}

	return null
}

/**
 * Generate field schema based on type and annotations
 */
function generateFieldSchema(field: FieldMeta, schemaType: SchemaType, imports: ImportsMeta): string | null {
	const { raw } = field
	const fieldName = field.name
	const annotations: FieldConstraints = field.constraints

	const isReadSchema = schemaType === "read"
	const isReadPartialSchema = schemaType === "readPartial"
	const isCreateSchema = schemaType === "create"
	const isUpdateSchema = schemaType === "update"
	const isMutativeSchema = isCreateSchema || isUpdateSchema

	const zodTypeBase = ((): string | null => {
		/* Handle c.enum() helper - both const reference and inline array */
		const enumHelperMatch = raw.match(/c\.enum\(\s*["'][^"']+["']\s*,\s*(\[.*?\]|\w+)\s*\)/)
		if (enumHelperMatch?.[1]) {
			const enumValue = enumHelperMatch[1]
			return `z.enum(${enumValue})`
		}

		/* Check for .$type<(typeof ENUM_NAME)[number]>() pattern first */
		if (field.enumName) {
			return `z.enum(${field.enumName})`
		}

		/* Check for c.json helper */
		if (/c\.json[<(]/.test(raw)) {
			if (!field.jsonSchemaName) {
				throw new Error(`c.json() must have schema as second parameter: ${raw}`)
			}

			let schema = field.jsonSchemaName

			if (annotations.maxBytes !== null && (schemaType === "create" || schemaType === "update")) {
				schema += `.refine((val) => !val || JSON.stringify(val).length <= ${annotations.maxBytes}, { message: "JSON exceeds ${annotations.maxBytes} characters when serialized" })`
			}

			return schema
		}

		/* Handle foreign key fields (c.ref or .references()) */
		if (field.foreignKey || /c\.ref[<(]/.test(raw)) {
			/* FK fields excluded from Update schemas - set once at creation */
			if (isUpdateSchema) {
				return null
			}
			/* Standard ID schema for FK fields */
			return "z.string().min(1).max(48)"
		}

		/* Handle text fields: c.text, c.enum, c.id, c.ref */
		if (/c\.(text|enum|id|ref)[<(]/.test(raw)) {
			/* Private fields excluded from read schemas (DTO-06) */
			if (annotations.private && (isReadSchema || isReadPartialSchema)) {
				return null
			}

			/* Check for z.infer<typeof schemaName> pattern */
			const hasTypeAnnotation = raw.includes(".$type<")
			if (hasTypeAnnotation) {
				const typeSchema = extractAndParseType(raw, imports.jsonSchemaImports)
				if (typeSchema && typeSchema !== "z.unknown()" && !typeSchema.startsWith("z.")) {
					return typeSchema
				}
			}

			let stringSchema: string

			if (annotations.password) {
				stringSchema = "z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/)"
			} else if (annotations.email) {
				/* Email: transforms only for Create/Update, validation for all */
				stringSchema = isMutativeSchema ? "z.email().trim().toLowerCase()" : "z.email()"
			} else if (annotations.url) {
				stringSchema = "z.url()"
			} else {
				stringSchema = "z.string()"
			}

			/* Transforms applied FIRST (normalize input), then validation (check bounds) */
			if (isMutativeSchema && !annotations.password && !annotations.email && !annotations.url) {
				if (annotations.trim) {
					stringSchema += ".trim()"
				}
				if (annotations.lowercase) {
					stringSchema += ".toLowerCase()"
				} else if (annotations.uppercase) {
					stringSchema += ".toUpperCase()"
				}
			}

			/* Apply min/max constraints */
			if (!annotations.password && !annotations.email) {
				const isIdField = fieldName === "id" || fieldName.endsWith("Id") || fieldName.endsWith("_id")

				if (isIdField && !field.length) {
					if (isMutativeSchema) {
						stringSchema += ".regex(/^\\S{1,48}$/)"
					} else {
						stringSchema += ".min(1).max(48)"
					}
				} else {
					if (annotations.min !== null) {
						stringSchema += `.min(${annotations.min})`
					} else if (field.isNotNull && isCreateSchema && !annotations.url) {
						stringSchema += ".min(1)"
					}

					/* Apply @max annotation first, fallback to length parameter */
					if (annotations.max !== null) {
						stringSchema += `.max(${annotations.max})`
					} else if (field.length !== null) {
						stringSchema += `.max(${field.length})`
					}

					if (annotations.pattern !== null && isMutativeSchema) {
						stringSchema += `.regex(${annotations.pattern})`
					}

					if (annotations.url && isMutativeSchema) {
						stringSchema += `.refine((v) => /^https:\\/\\//.test(v), { message: "Must be an HTTPS URL" })`
					}
				}
			} else if (annotations.email) {
				if (annotations.min !== null) {
					stringSchema += `.min(${annotations.min})`
				}
				if (annotations.max !== null) {
					stringSchema += `.max(${annotations.max})`
				} else if (field.length !== null) {
					stringSchema += `.max(${field.length})`
				}
			}

			return stringSchema
		}

		/* Wrapper integer/timestamp helpers */
		if (/c\.(createdAt|updatedAt|deletedAt)[<(]/.test(raw)) {
			return "timestampSchema"
		}

		if (/c\.timestamp[<(]/.test(raw)) {
			return "timestampSchema"
		}

		if (/c\.(integer|serialId)[<(]/.test(raw)) {
			let numberSchema = "z.number().int()"
			if (annotations.min !== null) {
				numberSchema += `.min(${annotations.min})`
			} else {
				numberSchema += ".nonnegative()"
			}
			numberSchema += ".max(Number.MAX_SAFE_INTEGER)"
			return numberSchema
		}

		if (/c\.boolean[<(]/.test(raw)) return "z.boolean()"
		if (/c\.real[<(]/.test(raw)) return "z.number()"

		return "z.unknown()"
	})()

	if (zodTypeBase === null) {
		return null
	}

	/* Append .meta() for OpenAPI examples */
	const exampleMeta = generateExampleMeta(field)
	let zodTypeWithMeta = exampleMeta ? `${zodTypeBase}${exampleMeta.code}` : zodTypeBase

	const shouldBeRequired = field.isPrimaryKey || field.isNotNull
	const shouldBeNullable = !shouldBeRequired

	let zodType = shouldBeNullable ? `${zodTypeWithMeta}.nullable()` : zodTypeWithMeta

	const makeOptional = (schema: string): string => `${schema}.optional()`

	if (isReadSchema) {
		/* All fields required */
	} else if (isReadPartialSchema) {
		zodType = makeOptional(zodType)
	} else if (isCreateSchema) {
		if (
			fieldName === "id" ||
			shouldBeNullable ||
			["createdAt", "updatedAt", "deletedAt", "created_at", "updated_at", "deleted_at"].includes(fieldName) ||
			annotations.autogenerate
		) {
			zodType = makeOptional(zodType)
		}
	} else if (isUpdateSchema) {
		zodType = makeOptional(zodType)
	}

	return zodType
}

/** Emitted code for a shared schema constant */
type SharedSchema = { code: string; count: number; name: string }

/**
 * Rejects zodTypes containing external identifiers (enum consts, imported schemas).
 */
/**
 * A zodType can be shared if it doesn't reference any external identifiers
 * (enum consts, imported JSON schemas). Uses actual import data, not heuristics.
 */
function canBeShared(zodType: string, externalIdentifiers: Set<string>): boolean {
	for (const id of externalIdentifiers) {
		if (zodType.includes(id)) return false
	}
	return true
}

/** Decompose a zodType into { base, nullable, optional } */
function decomposeZodType(zodType: string): { base: string; nullable: boolean; optional: boolean } {
	let s = zodType
	let optional = false
	let nullable = false
	if (s.endsWith(".optional()")) {
		optional = true
		s = s.slice(0, -".optional()".length)
	}
	if (s.endsWith(".nullable()")) {
		nullable = true
		s = s.slice(0, -".nullable()".length)
	}
	return { base: s, nullable, optional }
}

/**
 * Pass 2: compositional dedup.
 * Decomposes zodTypes into base + .nullable() + .optional() wrappers.
 * Shared base schemas get one constant, variants chain on top: `_z0.nullable()`.
 * Threshold: base used 2+ times across all variant forms.
 */
function buildSharedSchemas(tables: TableInfo[], imports: ImportsMeta): Map<string, SharedSchema> {
	/* Collect all external identifiers that can't appear in shared file */
	const externalIdentifiers = new Set<string>([...imports.enumImports.keys(), ...imports.jsonSchemaImports])
	/* Count every complete zodType (total occurrences + unique table count) */
	const fullCounts = new Map<string, number>()
	const tableCounts = new Map<string, Set<string>>()
	for (const table of tables) {
		for (const field of table.fields) {
			if (canBeShared(field.zodType, externalIdentifiers)) {
				fullCounts.set(field.zodType, (fullCounts.get(field.zodType) ?? 0) + 1)
				let ts = tableCounts.get(field.zodType)
				if (!ts) {
					ts = new Set()
					tableCounts.set(field.zodType, ts)
				}
				ts.add(table.name)
			}
		}
	}

	/* Group by base, accumulate total usage + unique tables per base */
	const baseGroups = new Map<string, { tables: Set<string>; total: number }>()
	for (const [zodType, count] of fullCounts) {
		const { base } = decomposeZodType(zodType)
		let group = baseGroups.get(base)
		if (!group) {
			group = { tables: new Set(), total: 0 }
			baseGroups.set(base, group)
		}
		group.total += count
		const zodTables = tableCounts.get(zodType)
		if (zodTables) {
			for (const t of zodTables) group.tables.add(t)
		}
	}

	/* Threshold: base total >= 3, OR base in 2+ tables with total >= 2 */
	const result = new Map<string, SharedSchema>()
	let idx = 0

	/* Sort bases by total usage desc */
	const sortedBases = [...baseGroups.entries()]
		.filter(([, g]) => g.total >= 3 || (g.tables.size >= 2 && g.total >= 2))
		.sort((a, b) => b[1].total - a[1].total)

	for (const [base] of sortedBases) {
		const baseName = `_z${idx}`
		idx++

		/* Emit base constant — rewrite z.string() → _str etc. */
		const baseCount = fullCounts.get(base) ?? 0
		const rewrittenBase = rewriteBaseTypes(base)
		if (baseCount > 0) {
			result.set(base, { code: rewrittenBase, count: baseCount, name: baseName })
		} else {
			result.set(base, { code: rewrittenBase, count: 0, name: baseName })
		}

		/* Emit .nullable() variant if used */
		const nullableType = `${base}.nullable()`
		const nullableCount = fullCounts.get(nullableType) ?? 0
		let nullableName: string | null = null
		/* Also needed if .nullable().optional() exists */
		const nullableOptionalType = `${base}.nullable().optional()`
		const nullableOptionalCount = fullCounts.get(nullableOptionalType) ?? 0
		if (nullableCount > 0 || nullableOptionalCount > 0) {
			nullableName = `_z${idx}`
			idx++
			result.set(nullableType, { code: `${baseName}.nullable()`, count: nullableCount, name: nullableName })
		}

		/* Emit .nullable().optional() variant if used */
		if (nullableOptionalCount > 0 && nullableName) {
			const noName = `_z${idx}`
			idx++
			result.set(nullableOptionalType, {
				code: `${nullableName}.optional()`,
				count: nullableOptionalCount,
				name: noName,
			})
		}

		/* Emit .optional() variant if used */
		const optionalType = `${base}.optional()`
		const optionalCount = fullCounts.get(optionalType) ?? 0
		if (optionalCount > 0) {
			const optName = `_z${idx}`
			idx++
			result.set(optionalType, { code: `${baseName}.optional()`, count: optionalCount, name: optName })
		}
	}

	/* Inject structural cores (base with .meta stripped) used across 2+ tables */
	const coreTableSets = new Map<string, Set<string>>()
	for (const table of tables) {
		for (const field of table.fields) {
			if (!canBeShared(field.zodType, externalIdentifiers)) continue
			const { base } = decomposeZodType(field.zodType)
			const [core, metaSuffix] = stripMeta(base)
			if (metaSuffix && core !== base && !result.has(core)) {
				let ts = coreTableSets.get(core)
				if (!ts) {
					ts = new Set()
					coreTableSets.set(core, ts)
				}
				ts.add(table.name)
			}
		}
	}
	for (const [core, coreTables] of coreTableSets) {
		if (coreTables.size >= 2) {
			const coreName = `_z${idx}`
			idx++
			result.set(core, { code: rewriteBaseTypes(core), count: 0, name: coreName })
		}
	}

	return result
}

/**
 * Base Zod type aliases — each constructor called once in shared, everything chains on it.
 * Order matters: longer prefixes first to avoid partial matches.
 */
const BASE_TYPE_ALIASES: Array<[string, string]> = [
	["z.number().int().nonnegative()", "_intNN"],
	["z.number().int()", "_int"],
	["z.number()", "_num"],
	["z.string()", "_str"],
	["z.boolean()", "_bool"],
	["z.email()", "_eml"],
	["z.url()", "_url"],
]

/** Replace z.string() → _str, z.number().int() → _int, etc. in a zodType string */
function rewriteBaseTypes(zodType: string): string {
	let result = zodType
	for (const [from, to] of BASE_TYPE_ALIASES) {
		if (result.startsWith(from)) {
			result = to + result.slice(from.length)
			break
		}
	}
	return result
}

/** Strip trailing .meta(...) from a zodType, returning [core, metaSuffix] */
function stripMeta(zodType: string): [string, string] {
	const metaIdx = zodType.lastIndexOf(".meta(")
	if (metaIdx === -1) return [zodType, ""]
	/* Find matching close paren — handle one level of nesting */
	let depth = 0
	for (let i = metaIdx + 5; i < zodType.length; i++) {
		if (zodType[i] === "(") depth++
		else if (zodType[i] === ")") {
			depth--
			if (depth === 0) {
				return [zodType.slice(0, metaIdx), zodType.slice(metaIdx, i + 1)]
			}
		}
	}
	return [zodType, ""]
}

/**
 * Rewrite an inline zodType to reference shared _z* constants where possible.
 * Decomposes into core + .meta() + .nullable() + .optional(), then checks if
 * the core (or core+meta, or core+meta+nullable) matches a shared constant.
 */
function rewriteWithShared(zodType: string, sharedSchemas: Map<string, SharedSchema>): string {
	/* Already fully shared */
	const fullShared = sharedSchemas.get(zodType)
	if (fullShared) return fullShared.name

	/* Decompose into layers */
	let remainder = zodType
	let optionalSuffix = ""
	let nullableSuffix = ""

	if (remainder.endsWith(".optional()")) {
		optionalSuffix = ".optional()"
		remainder = remainder.slice(0, -".optional()".length)
	}
	if (remainder.endsWith(".nullable()")) {
		nullableSuffix = ".nullable()"
		remainder = remainder.slice(0, -".nullable()".length)
	}

	/* Check if base+meta+nullable matches shared */
	const withNullable = remainder + nullableSuffix
	const sharedWithNullable = sharedSchemas.get(withNullable)
	if (sharedWithNullable) return sharedWithNullable.name + optionalSuffix

	/* Check if base+meta matches shared */
	const sharedBase = sharedSchemas.get(remainder)
	if (sharedBase) return sharedBase.name + nullableSuffix + optionalSuffix

	/* Strip .meta() and check if structural core matches shared */
	const [core, metaSuffix] = stripMeta(remainder)
	if (metaSuffix) {
		const sharedCore = sharedSchemas.get(core)
		if (sharedCore) return sharedCore.name + metaSuffix + nullableSuffix + optionalSuffix
	}

	/* No shared match — just rewrite base types */
	return rewriteBaseTypes(zodType)
}

type TimestampCombo = "Created" | "CreatedUpdated" | "CreatedUpdatedDeleted"
type UsedTimestampCombos = { camelCase: Set<TimestampCombo>; snakeCase: Set<TimestampCombo> }

/**
 * Analyze tables to determine which timestamp combos are actually used
 */
function collectUsedTimestampCombos(tables: TableInfo[]): UsedTimestampCombos {
	const result: UsedTimestampCombos = { camelCase: new Set(), snakeCase: new Set() }

	for (const table of tables) {
		const { createdAt, updatedAt, deletedAt } = table.hasTimestamps
		if (!createdAt) continue

		const target = table.timestampStyle === "snake_case" ? result.snakeCase : result.camelCase

		if (createdAt && updatedAt && deletedAt) {
			target.add("CreatedUpdatedDeleted")
		} else if (createdAt && updatedAt) {
			target.add("CreatedUpdated")
		} else {
			target.add("Created")
		}
	}

	return result
}

/**
 * Generate shared _shared/index.gen.ts content — only emits combos actually used
 */
function generateSharedFile(used: UsedTimestampCombos, sharedSchemas: Map<string, SharedSchema>): string {
	const lines: string[] = []

	lines.push(`import * as z from "zod"`)
	lines.push("")
	/* Base Zod type aliases — each constructor called once */
	for (const [expr, alias] of BASE_TYPE_ALIASES) {
		lines.push(`export const ${alias} = ${expr}`)
	}
	lines.push("")
	/* Shared meta example objects — one allocation, referenced everywhere */
	lines.push("/** Shared meta example objects for OpenAPI — avoids repeated inline allocations */")
	lines.push("export const _m = {")
	for (const key of SHARED_META_KEYS) {
		lines.push(`\t${key}: ${SHARED_META_VALUES[key]},`)
	}
	lines.push("}")
	lines.push("")
	lines.push("/** Shared complete schemas — identical across all entities */")
	for (const [name, schema] of Object.entries(SHARED_SCHEMAS)) {
		lines.push(`export const _s_${name} = ${rewriteBaseTypes(schema)}`)
	}
	lines.push("")
	lines.push("/** Base timestamp field - allows Unix epoch (0) */")
	lines.push(
		`export const timestampSchema = ${rewriteBaseTypes("z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)")}.meta(_m.timestamp)`,
	)
	lines.push("")
	lines.push("/** Nullable timestamp field */")
	lines.push("export const timestampNullableSchema = _intNN.max(Number.MAX_SAFE_INTEGER).nullable()")
	lines.push("")

	/* Auto-deduped shared schema constants — must be before timestamp spreads that reference them */
	if (sharedSchemas.size > 0) {
		lines.push("/** Auto-deduped schemas — variants chain on shared bases */")
		for (const { code, count, name } of sharedSchemas.values()) {
			const comment = count > 0 ? ` /* ${count}x */` : ""
			lines.push(`export const ${name} = ${code}${comment}`)
		}
		lines.push("")
	}

	if (used.camelCase.size > 0) {
		emitTimestampVariants(lines, used.camelCase, "camelCase", sharedSchemas)
	}

	if (used.snakeCase.size > 0) {
		emitTimestampVariants(lines, used.snakeCase, "snake_case", sharedSchemas)
	}

	return lines.join("\n")
}

function emitTimestampVariants(
	lines: string[],
	combos: Set<TimestampCombo>,
	style: "camelCase" | "snake_case",
	sharedSchemas: Map<string, SharedSchema>,
): void {
	const isSnake = style === "snake_case"
	const suffix = isSnake ? "SnakeCase" : ""
	const c = isSnake ? "created_at" : "createdAt"
	const u = isSnake ? "updated_at" : "updatedAt"
	const d = isSnake ? "deleted_at" : "deletedAt"

	const hasUpdated = combos.has("CreatedUpdated") || combos.has("CreatedUpdatedDeleted")
	const hasDeleted = combos.has("CreatedUpdatedDeleted")

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

	if (hasUpdated || hasDeleted) {
		lines.push("")
		lines.push(`export const timestampsReadRefinements${suffix} = {`)
		if (hasDeleted) {
			lines.push("\tdeletedAfterCreated: {")
			lines.push(`\t\tmessage: "${d} cannot be before ${c}",`)
			lines.push(`\t\tpath: ["${d}"]`)
			lines.push("\t},")
		}
		if (hasUpdated) {
			lines.push("\tupdatedAfterCreated: {")
			lines.push(`\t\tmessage: "${u} cannot be before ${c}",`)
			lines.push(`\t\tpath: ["${u}"]`)
			lines.push("\t},")
		}
		lines.push("}")
		lines.push("")
		lines.push(`export const timestampsOptionalRefinements${suffix} = {`)
		if (hasDeleted) {
			lines.push("\tdeletedAfterCreated: {")
			lines.push(`\t\tmessage: "${d} cannot be before ${c}",`)
			lines.push(`\t\tpath: ["${d}"]`)
			lines.push("\t},")
		}
		if (hasUpdated) {
			lines.push("\tupdatedAfterCreated: {")
			lines.push(`\t\tmessage: "${u} cannot be before ${c}",`)
			lines.push(`\t\tpath: ["${u}"]`)
			lines.push("\t},")
		}
		lines.push("}")
		lines.push("")
	}

	/* Resolve timestamp schema refs — use _z* if available */
	const resolveTs = (zodType: string): string => sharedSchemas.get(zodType)?.name ?? zodType

	const tsRaw = resolveTs("timestampSchema")
	const tsN = resolveTs("timestampSchema.nullable()")
	const tsO = resolveTs("timestampSchema.optional()")
	const tsNO = resolveTs("timestampSchema.nullable().optional()")

	for (const combo of combos) {
		const fields = getTimestampFields(combo, c, u, d)

		/* Read */
		lines.push(`export const timestamps${combo}Read${suffix} = {`)
		for (const f of fields) {
			lines.push(`\t${f.name}: ${f.nullable ? tsN : tsRaw},`)
		}
		lines.push("}")
		lines.push("")

		/* ReadPartial */
		lines.push(`export const timestamps${combo}ReadPartial${suffix} = {`)
		for (const f of fields) {
			lines.push(`\t${f.name}: ${f.nullable ? tsNO : tsO},`)
		}
		lines.push("}")
		lines.push("")

		/* Create */
		lines.push(`export const timestamps${combo}Create${suffix} = {`)
		for (const f of fields) {
			lines.push(`\t${f.name}: ${f.nullable ? tsNO : tsO},`)
		}
		lines.push("}")
		lines.push("")
	}
}

function getTimestampFields(
	combo: TimestampCombo,
	c: string,
	u: string,
	d: string,
): { name: string; nullable: boolean }[] {
	switch (combo) {
		case "Created":
			return [{ name: c, nullable: false }]
		case "CreatedUpdated":
			return [
				{ name: c, nullable: false },
				{ name: u, nullable: false },
			]
		case "CreatedUpdatedDeleted":
			return [
				{ name: c, nullable: false },
				{ name: d, nullable: true },
				{ name: u, nullable: false },
			]
	}
}

/**
 * Render entity facts as a TypeScript object literal.
 *
 * Keys are emitted in a fixed order so regenerating an unchanged table
 * produces an identical file and the checksum header stays put.
 */
/** Render the published state subset, or `null`. */
function renderStates(states: CombEntityMetaInput["states"]): string {
	if (states === null) return "null"
	const list = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`
	return [
		"{",
		`\t\tcolumn: ${JSON.stringify(states.column)},`,
		`\t\tinitial: ${states.initial === null ? "null" : JSON.stringify(states.initial)},`,
		`\t\tterminal: ${list(states.terminal)},`,
		`\t\tvalues: ${list(states.values)},`,
		"\t}",
	].join("\n")
}

function renderCombMeta(meta: CombEntityMetaInput): string {
	const list = (values: string[]) => `[${values.map((v) => JSON.stringify(v)).join(", ")}]`
	const nullable = (value: string | null) => (value === null ? "null" : JSON.stringify(value))
	return [
		"{",
		`\tgenerated: ${list(meta.generated)},`,
		`\tidentity: ${JSON.stringify(meta.identity)},`,
		`\timmutable: ${list(meta.immutable)},`,
		`\tkind: "entity",`,
		`\tname: ${JSON.stringify(meta.name)},`,
		`\tsoftDelete: ${nullable(meta.softDelete)},`,
		`\tstates: ${renderStates(meta.states)},`,
		`\ttenantColumn: ${nullable(meta.tenantColumn)},`,
		"}",
	].join("\n")
}

/**
 * Generate entity file content
 */
function generateEntityFile(
	table: TableInfo,
	_enumImportPaths: Map<string, Set<string>>,
	jsonSchemasRelativePath: string,
	imports: ImportsMeta,
	sharedSchemas: Map<string, SharedSchema>,
	filePrefix?: string | undefined,
	metaImportFrom = "@lovrozagar/comb/meta",
): string {
	const lines: string[] = []
	const { combMeta, fields, hasTimestamps, name, needsSharedMeta, timestampStyle, usedEnums, usedJsonSchemas } = table

	lines.push(`import * as z from "zod"`)
	if (combMeta) {
		lines.push(`import { combMeta } from "${metaImportFrom}"`)
	}

	/* Add enum imports */
	const entityEnumImports = new Map<string, Set<string>>()
	for (const enumConstant of usedEnums) {
		const importPath = imports.identifiers.get(enumConstant)
		if (importPath) {
			const existing = entityEnumImports.get(importPath) ?? new Set<string>()
			existing.add(enumConstant)
			entityEnumImports.set(importPath, existing)
		}
	}

	for (const [importPath, identifiers] of entityEnumImports) {
		const sortedIdentifiers = Array.from(identifiers).sort()
		lines.push(`import { ${sortedIdentifiers.join(", ")} } from "${importPath}"`)
	}

	/* Add JSON schema imports */
	if (usedJsonSchemas.size > 0) {
		const sortedSchemas = Array.from(usedJsonSchemas).sort()
		lines.push(`import { ${sortedSchemas.join(", ")} } from "${jsonSchemasRelativePath}"`)
	}

	/* Add shared imports */
	const sharedImports: string[] = []

	if (needsSharedMeta) {
		sharedImports.push("_m")
	}

	const isSnakeCase = timestampStyle === "snake_case"
	const suffix = isSnakeCase ? "SnakeCase" : ""

	/* Track which field keys are handled by timestamp spreads */
	const spreadFieldKeys = new Set<string>()

	if (hasTimestamps.createdAt && hasTimestamps.updatedAt && hasTimestamps.deletedAt) {
		sharedImports.push(
			`timestampsCreatedUpdatedDeletedCreate${suffix}`,
			`timestampsCreatedUpdatedDeletedRead${suffix}`,
			`timestampsCreatedUpdatedDeletedReadPartial${suffix}`,
		)
		spreadFieldKeys.add(isSnakeCase ? "created_at" : "createdAt")
		spreadFieldKeys.add(isSnakeCase ? "updated_at" : "updatedAt")
		spreadFieldKeys.add(isSnakeCase ? "deleted_at" : "deletedAt")
	} else if (hasTimestamps.createdAt && hasTimestamps.updatedAt) {
		sharedImports.push(
			`timestampsCreatedUpdatedCreate${suffix}`,
			`timestampsCreatedUpdatedRead${suffix}`,
			`timestampsCreatedUpdatedReadPartial${suffix}`,
		)
		spreadFieldKeys.add(isSnakeCase ? "created_at" : "createdAt")
		spreadFieldKeys.add(isSnakeCase ? "updated_at" : "updatedAt")
	} else if (hasTimestamps.createdAt && hasTimestamps.deletedAt) {
		sharedImports.push(
			`timestampsCreatedCreate${suffix}`,
			`timestampsCreatedRead${suffix}`,
			`timestampsCreatedReadPartial${suffix}`,
		)
		spreadFieldKeys.add(isSnakeCase ? "created_at" : "createdAt")
	} else if (hasTimestamps.createdAt) {
		sharedImports.push(
			`timestampsCreatedCreate${suffix}`,
			`timestampsCreatedRead${suffix}`,
			`timestampsCreatedReadPartial${suffix}`,
		)
		spreadFieldKeys.add(isSnakeCase ? "created_at" : "createdAt")
	}

	/* Only import timestampSchema if non-spread, non-deduped fields reference it */
	const needsTimestampSchema = fields.some(
		(f) => f.zodType.includes("timestampSchema") && !spreadFieldKeys.has(f.key) && !sharedSchemas.has(f.zodType),
	)
	if (needsTimestampSchema) {
		sharedImports.push("timestampSchema")
	}

	/* Pre-scan: collect _z* shared schema names and base type aliases used by this entity */
	const usedSharedNames = new Set<string>()
	for (const f of fields) {
		if (spreadFieldKeys.has(f.key)) continue
		const shared = sharedSchemas.get(f.zodType)
		if (shared) {
			usedSharedNames.add(shared.name)
		} else {
			/* Resolve inline schema — may reference _z* or base aliases */
			const resolved = rewriteWithShared(f.zodType, sharedSchemas)
			/* Extract _z* refs from resolved string */
			const zRefs = resolved.match(/_z\d+/g)
			if (zRefs) {
				for (const ref of zRefs) usedSharedNames.add(ref)
			}
			/* Check which base type alias it needs */
			for (const [, alias] of BASE_TYPE_ALIASES) {
				if (resolved.startsWith(alias)) {
					sharedImports.push(alias)
					break
				}
			}
		}
	}
	for (const sharedName of usedSharedNames) {
		sharedImports.push(sharedName)
	}

	if (sharedImports.length > 0) {
		const dedupedImports = [...new Set(sharedImports)].sort()
		const sharedImportPath = filePrefix ? `../_shared/${filePrefix}._shared.gen` : "../_shared/index.gen"
		lines.push(`import { ${dedupedImports.join(", ")} } from "${sharedImportPath}"`)
	}
	lines.push("")

	/* Intra-entity dedup: local consts for inline zodTypes appearing 2+ times within this entity */
	const inlineFieldCounts = new Map<string, number>()
	for (const f of fields) {
		if (spreadFieldKeys.has(f.key)) continue
		if (sharedSchemas.has(f.zodType)) continue
		inlineFieldCounts.set(f.zodType, (inlineFieldCounts.get(f.zodType) ?? 0) + 1)
	}
	const localConsts = new Map<string, string>()
	let localIdx = 0
	for (const [zodType, count] of inlineFieldCounts) {
		if (count >= 2) {
			const rewritten = rewriteWithShared(zodType, sharedSchemas)
			const localName = `_l${localIdx}`
			localConsts.set(zodType, localName)
			lines.push(`const ${localName} = ${rewritten}`)
			localIdx++
		}
	}
	if (localConsts.size > 0) lines.push("")

	/* Generate schemas for each type */
	const schemaTypes: SchemaType[] = ["read", "readPartial", "create", "update"]

	for (const type of schemaTypes) {
		const typeFields = fields.filter((f) => f.type === type)
		if (typeFields.length === 0) continue

		const outputSuffix = schemaTypeToOutputSuffix[type]
		const schemaName = `${snakeToCamel(name)}${outputSuffix}Schema`

		/* Determine timestamp spread based on timestamp style */
		let spreadName: string | null = null
		let timestampFieldsToFilter: string[] = []

		if (hasTimestamps.createdAt && hasTimestamps.updatedAt && hasTimestamps.deletedAt) {
			if (type === "read") spreadName = `timestampsCreatedUpdatedDeletedRead${suffix}`
			else if (type === "readPartial") spreadName = `timestampsCreatedUpdatedDeletedReadPartial${suffix}`
			else if (type === "create") spreadName = `timestampsCreatedUpdatedDeletedCreate${suffix}`
			timestampFieldsToFilter = isSnakeCase
				? ["created_at", "updated_at", "deleted_at"]
				: ["createdAt", "updatedAt", "deletedAt"]
		} else if (hasTimestamps.createdAt && hasTimestamps.updatedAt) {
			if (type === "read") spreadName = `timestampsCreatedUpdatedRead${suffix}`
			else if (type === "readPartial") spreadName = `timestampsCreatedUpdatedReadPartial${suffix}`
			else if (type === "create") spreadName = `timestampsCreatedUpdatedCreate${suffix}`
			timestampFieldsToFilter = isSnakeCase ? ["created_at", "updated_at"] : ["createdAt", "updatedAt"]
		} else if (hasTimestamps.createdAt) {
			if (type === "read") spreadName = `timestampsCreatedRead${suffix}`
			else if (type === "readPartial") spreadName = `timestampsCreatedReadPartial${suffix}`
			else if (type === "create") spreadName = `timestampsCreatedCreate${suffix}`
			timestampFieldsToFilter = isSnakeCase ? ["created_at"] : ["createdAt"]
		}

		/* Filter out timestamp fields if spreading */
		const nonTimestampFields = spreadName
			? typeFields.filter((f) => !timestampFieldsToFilter.includes(f.key))
			: typeFields

		lines.push(`export const ${schemaName} = z.object({`)

		if (spreadName) {
			lines.push(`\t...${spreadName},`)
		}

		for (const field of nonTimestampFields) {
			const local = localConsts.get(field.zodType)
			if (local) {
				lines.push(`\t${field.key}: ${local},`)
				continue
			}
			const shared = sharedSchemas.get(field.zodType)
			if (shared) {
				usedSharedNames.add(shared.name)
				lines.push(`\t${field.key}: ${shared.name},`)
				continue
			}
			lines.push(`\t${field.key}: ${rewriteWithShared(field.zodType, sharedSchemas)},`)
		}

		/* Entity facts ride on the read schema — the one a response is validated
		   against — so a consumer reads them off the same object. docs/meta-contract.md */
		if (type === "read" && combMeta) {
			lines.push(`}).meta(combMeta(${renderCombMeta(combMeta)}))`)
		} else {
			lines.push("})")
		}
		lines.push("")
	}

	/* Add type exports */
	lines.push("/* TypeScript types */")
	for (const type of schemaTypes) {
		const typeFields = fields.filter((f) => f.type === type)
		if (typeFields.length === 0) continue

		const pascalName = snakeToPascal(name)
		const camelName = snakeToCamel(name)
		const outputSuffix = schemaTypeToOutputSuffix[type]
		const typeName = `${pascalName}${outputSuffix}`
		const schemaName = `${camelName}${outputSuffix}Schema`
		lines.push(`export type ${typeName} = z.infer<typeof ${schemaName}>`)
	}
	lines.push("")

	return lines.join("\n")
}

/**
 * Update package.json exports
 */
function updatePackageJson(
	packageJsonPath: string,
	entities: string[],
	outputDir: string,
	tablesPath: string,
	cwd: string,
	filePrefix?: string | undefined,
): void {
	const content = fs.readFileSync(packageJsonPath, "utf-8")
	const pkg = JSON.parse(content) as Record<string, unknown>

	const packageDir = path.dirname(packageJsonPath)
	const absoluteOutputDir = path.resolve(cwd, outputDir)
	const relativeOutputDir = `./${path.relative(packageDir, absoluteOutputDir)}`

	/* Extract db name for tables and relations exports */
	const dbName = extractDbName(tablesPath)
	const fp = filePrefix ?? `db.${dbName}`
	const relationsFileName = `${fp}.relations.gen.ts`

	const existingExports = (pkg["exports"] ?? {}) as Record<string, string>
	const newExports: Record<string, string> = {}

	if (existingExports["."]) {
		newExports["."] = existingExports["."]
	}

	const sharedFileName = filePrefix ? `${filePrefix}._shared.gen.ts` : "index.gen.ts"
	newExports["./dtos/_shared"] = `${relativeOutputDir}/_shared/${sharedFileName}`

	for (const entity of entities.sort()) {
		const kebabName = camelToKebab(entity)
		const entityFileName = filePrefix ? `${filePrefix}.${kebabName}.gen.ts` : "index.gen.ts"
		newExports[`./dtos/${kebabName}`] = `${relativeOutputDir}/${kebabName}/${entityFileName}`
	}

	/* Find tables and relations file paths relative to package dir */
	const absoluteTablesPath = path.resolve(cwd, tablesPath)
	const relativeTablesPath = `./${path.relative(packageDir, absoluteTablesPath)}`

	const absoluteRelationsPath = path.join(path.dirname(absoluteTablesPath), relationsFileName)
	const relativeRelationsPath = `./${path.relative(packageDir, absoluteRelationsPath)}`

	/* Add tables and relations exports */
	newExports["./relations"] = relativeRelationsPath
	newExports["./tables"] = relativeTablesPath

	for (const [key, value] of Object.entries(existingExports)) {
		if (key !== "." && !key.startsWith("./dtos/") && key !== "./tables" && key !== "./relations") {
			newExports[key] = value as string
		}
	}

	pkg["exports"] = newExports

	writeJsonAtomic(packageJsonPath, pkg)
	console.log(`Updated package.json exports with ${entities.length} entities`)
}
