/**
 * Shared ts-morph helpers
 */
import { createRequire } from "node:module"
import path from "node:path"
import type { Node } from "ts-morph"
import { Project, SyntaxKind } from "ts-morph"

/** Create a ts-morph project optimized for code generation */
export function createProject(): Project {
	return new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
	})
}

/**
 * Create a ts-morph project and add all .ts files from the tables file directory.
 * This follows re-exports from preset files.
 */
export function createProjectFromTablesDir(tablesPath: string): Project {
	const project = createProject()
	const srcDir = path.dirname(tablesPath)
	project.addSourceFilesAtPaths(`${srcDir}/**/*.ts`)
	return project
}

/**
 * Extract database name from tables file path.
 * Handles both legacy (db.core.tables.ts) and saas ({name}.db.{dbName}.tables.gen.ts) patterns.
 */
export function extractDbName(filePath: string): string {
	const fileName = path.basename(filePath)
	/* prefixed pattern: anyrow.db-core.tables.ts -> core */
	const prefixedMatch = fileName.match(/\.db-(\w+)\.tables/)
	if (prefixedMatch?.[1] !== undefined) return prefixedMatch[1]
	/* saas pattern: test.db.core.tables.gen.ts -> core */
	const saasMatch = fileName.match(/\.db\.(\w+)\.tables/)
	if (saasMatch?.[1] !== undefined) return saasMatch[1]
	/* legacy pattern: db.core.tables.ts -> core */
	const legacyMatch = fileName.match(/^db\.(\w+)\.tables/)
	if (legacyMatch?.[1] !== undefined) return legacyMatch[1]
	return "db"
}

/**
 * Get the import path for the tables file (without extension), relative to same directory.
 * e.g. test.db.core.tables.gen.ts -> ./test.db.core.tables.gen
 */
export function getTablesImportPath(tablesPath: string): string {
	const basename = path.basename(tablesPath, ".ts")
	return `./${basename}`
}

/**
 * Extract enum name from:
 * - .$type<(typeof ENUM_NAME)[number]>() pattern
 * - c.enum("name", ENUM_NAME) pattern
 */
export function extractEnumFromType(raw: string): string | null {
	/* Check for .$type<(typeof ENUM_NAME)[number]> pattern */
	const typePattern = /\.\$type<\(typeof\s+(\w+)\)\[number\]>/
	const typeMatch = raw.match(typePattern)
	if (typeMatch && typeMatch[1] !== undefined) return typeMatch[1]

	/* Check for c.enum("name", ENUM_NAME) pattern */
	const enumHelperPattern = /c\.enum\(\s*["'][^"']+["']\s*,\s*(\w+)\s*\)/
	const enumMatch = raw.match(enumHelperPattern)
	if (enumMatch && enumMatch[1] !== undefined) return enumMatch[1]

	return null
}

/**
 * Extract length constraint from field definition
 * Prioritizes constraints.max, falls back to legacy formats
 */
export function extractLength(raw: string): number | null {
	/* Try max constraint (new format) */
	const constraints = extractConstraints(raw)
	if (typeof constraints["max"] === "number") {
		return constraints["max"]
	}

	/* Fallback: positional parameter c.text("name", 50) */
	const positionalMatch = raw.match(/c\.text\("[\w_]+",\s*(\d+)/)
	if (positionalMatch && positionalMatch[1] !== undefined) {
		return parseInt(positionalMatch[1], 10)
	}

	/* Fallback: object property { length: 50 } */
	const lengthMatch = raw.match(/length:\s*(\d+)/)
	if (lengthMatch && lengthMatch[1] !== undefined) {
		return parseInt(lengthMatch[1], 10)
	}

	return null
}

/** Check if text starts with a table definition function */
export function isTableDefinition(text: string): boolean {
	return text.startsWith("createTable")
}

/** Get actual table name from table definition call */
export function getTableName(variableName: string, initializer: Node): string {
	const callExpr = initializer.asKind(SyntaxKind.CallExpression)
	if (!callExpr) return variableName

	const args = callExpr.getArguments()
	const firstArg = args[0]
	if (firstArg) {
		return firstArg.getText().replace(/['"]/g, "")
	}
	return variableName
}

/** Parse z.infer<typeof schemaName> patterns from raw text */
export function extractJsonSchemaImports(raw: string): string[] {
	const schemas: string[] = []
	const inferPattern = /z\.infer<typeof\s+(\w+)>/g
	let match = inferPattern.exec(raw)
	while (match !== null) {
		const schemaName = match[1]
		if (schemaName !== undefined) {
			schemas.push(schemaName)
		}
		match = inferPattern.exec(raw)
	}
	return schemas
}

/**
 * Resolved identifier values for constraint objects.
 * Maps `"identifier.PROPERTY"` -> runtime string value.
 * Populated by the codegen pre-scan to resolve references like `patterns.E164_PHONE`.
 */
let identifierValueMap = new Map<string, string>()

/**
 * Set the identifier value map for constraint resolution.
 * Call this before parsing table definitions so that dotted references
 * in constraint objects (e.g. `patterns.E164_PHONE`) resolve to their values.
 */
export function setIdentifierValueMap(map: Map<string, string>): void {
	identifierValueMap = map
}

/**
 * Build an identifier value map by requiring imported modules and extracting
 * their exported object properties. Resolves workspace package paths from `cwd`.
 */
export function buildIdentifierValueMap(importedIds: Map<string, string>, cwd: string): Map<string, string> {
	const map = new Map<string, string>()
	const _require = createRequire(`${path.resolve(cwd)}/`)

	for (const [identifier, modulePath] of importedIds) {
		try {
			const mod = _require(modulePath) as Record<string, unknown>
			const obj = mod[identifier]
			if (typeof obj !== "object" || obj === null) continue

			for (const [key, value] of Object.entries(obj)) {
				if (typeof value === "string") {
					map.set(`${identifier}.${key}`, value)
				}
			}
		} catch {
			/* Module not resolvable from consumer context, skip */
		}
	}

	return map
}

/**
 * Extract constraint object from column function parameter or type argument
 * Parameter format: c.text("name", { min: 5, max: 254 })
 * Type arg format: c.text<{ min: 5, max: 254 }>("name")
 */
export function extractConstraints(raw: string): Record<string, unknown> {
	/* Try parameter-based constraints first (new format) */
	const paramContent = extractBalancedBraces(raw, /c\.\w+\([^{]*\{/)
	if (paramContent !== null) {
		return parseConstraintObject(paramContent)
	}

	/* Fallback to type argument for backward compatibility */
	const typeContent = extractBalancedBraces(raw, /c\.\w+<\s*\{/)
	if (typeContent !== null) {
		return parseConstraintObject(typeContent)
	}

	return {}
}

/**
 * Extract content between balanced braces after a pattern match
 * Handles nested braces in regex literals like /\d{7,14}/
 */
function extractBalancedBraces(raw: string, startPattern: RegExp): string | null {
	const match = startPattern.exec(raw)
	if (!match) return null

	const startPos = match.index + match[0].length
	let depth = 1
	let inRegex = false
	let inString: string | null = null
	let i = startPos

	while (i < raw.length && depth > 0) {
		const ch = raw[i]
		if (inString !== null) {
			if (ch === "\\" && i + 1 < raw.length) {
				i += 2
				continue
			}
			if (ch === inString) inString = null
		} else if (inRegex) {
			if (ch === "\\" && i + 1 < raw.length) {
				i += 2
				continue
			}
			if (ch === "/") inRegex = false
		} else {
			if (ch === '"' || ch === "'") {
				inString = ch
			} else if (ch === "/") {
				const prev = i > 0 ? raw[i - 1] : ""
				if (prev === " " || prev === ":" || prev === ",") inRegex = true
			} else if (ch === "{") {
				depth++
			} else if (ch === "}") {
				depth--
			}
		}
		i++
	}

	if (depth !== 0) return null
	return raw.substring(startPos, i - 1)
}

/** Parse constraint object literal string into record */
function parseConstraintObject(content: string): Record<string, unknown> {
	try {
		const pairs = splitConstraintPairs(content)
		const result: Record<string, unknown> = {}

		for (const pair of pairs) {
			const colonIndex = pair.indexOf(":")
			if (colonIndex === -1) continue

			const key = pair.substring(0, colonIndex).trim()
			const value = pair.substring(colonIndex + 1).trim()

			/* Parse value based on type */
			if (value === "true") {
				result[key] = true
			} else if (value === "false") {
				result[key] = false
			} else if (/^\d+$/.test(value)) {
				result[key] = parseInt(value, 10)
			} else if (value.startsWith('"') && value.endsWith('"')) {
				/* Un-escape TS string escapes so raw patterns like "\\d" become "\d" */
				result[key] = value.slice(1, -1).replace(/\\\\/g, "\\")
			} else if (value.startsWith("'") && value.endsWith("'")) {
				result[key] = value.slice(1, -1).replace(/\\\\/g, "\\")
			} else if (identifierValueMap.has(value)) {
				result[key] = identifierValueMap.get(value)
			} else {
				result[key] = value
			}
		}

		return result
	} catch {
		return {}
	}
}

/** Split constraint pairs on commas, respecting regex and string literals */
function splitConstraintPairs(content: string): string[] {
	const pairs: string[] = []
	let current = ""
	let inRegex = false
	let inString: string | null = null
	let i = 0

	while (i < content.length) {
		const ch = content[i]
		if (inString !== null) {
			current += ch
			if (ch === "\\" && i + 1 < content.length) {
				i++
				current += content[i]
			} else if (ch === inString) {
				inString = null
			}
		} else if (inRegex) {
			current += ch
			if (ch === "\\" && i + 1 < content.length) {
				i++
				current += content[i]
			} else if (ch === "/") {
				inRegex = false
			}
		} else if (ch === '"' || ch === "'") {
			inString = ch
			current += ch
		} else if (ch === "/") {
			/* Heuristic: regex start if preceded by colon or whitespace */
			const trimmed = current.trimEnd()
			if (trimmed.endsWith(":") || trimmed === "") {
				inRegex = true
			}
			current += ch
		} else if (ch === ",") {
			const trimmed = current.trim()
			if (trimmed) pairs.push(trimmed)
			current = ""
		} else {
			current += ch
		}
		i++
	}

	const trimmed = current.trim()
	if (trimmed) pairs.push(trimmed)

	return pairs
}
