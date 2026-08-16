/**
 * Error translation generator from database constraints
 *
 * Generates error keys and i18n translation files from constraint maps
 */
import path from "node:path"
import { toScreamingSnakeCase } from "../utils/case.ts"
import { ensureDir, writeGenFile } from "../utils/fs.ts"
import { createProject } from "../utils/ts-morph.ts"

type TranslationsConfig = {
	baseDir: string
}

/**
 * Derive database name from constraints file path.
 * Handles: test.db.core.constraints.gen.ts and db.core.constraints.gen.ts
 */
function extractDbNameFromConstraints(filePath: string): string {
	const fileName = path.basename(filePath)
	/* prefixed pattern: anyrow.db-core.constraints.gen.ts -> core */
	const prefixedMatch = fileName.match(/\.db-(\w+)\.constraints/)
	if (prefixedMatch?.[1] !== undefined) return prefixedMatch[1]
	/* saas pattern: test.db.core.constraints.gen.ts -> core */
	const saasMatch = fileName.match(/\.db\.(\w+)\.constraints/)
	if (saasMatch?.[1] !== undefined) return saasMatch[1]
	/* legacy pattern: db.core.constraints.gen.ts -> core */
	const legacyMatch = fileName.match(/^db\.(\w+)\.constraints/)
	if (legacyMatch?.[1] !== undefined) return legacyMatch[1]
	return "db"
}

/** Convert error key to human-readable message (en-US) */
function errorKeyToEnglishMessage(errorKey: string): string {
	const parts = errorKey.split("_")

	if (errorKey.endsWith("_duplicate")) {
		const field = parts[parts.length - 2]
		if (field === undefined || field === "id") {
			return "Record with this ID already exists"
		}
		return `A record with this ${field.replaceAll("_", " ")} already exists`
	}

	if (errorKey.endsWith("_reference_not_found")) {
		return "Referenced record does not exist"
	}

	return "An error occurred. Please try again."
}

/** Extract all error keys from constraint map file */
function extractErrorKeys(constraintsFilePath: string): string[] {
	const project = createProject()
	project.addSourceFilesAtPaths(constraintsFilePath)

	const errorKeys = new Set<string>()

	for (const file of project.getSourceFiles()) {
		const content = file.getFullText()
		const errorKeyPattern = /errorKey:\s*["']([^"']+)["']/g
		let match: RegExpExecArray | null = errorKeyPattern.exec(content)

		while (match !== null) {
			const key = match[1]
			if (key !== undefined && /^[a-zA-Z][a-zA-Z0-9_]+$/.test(key)) {
				errorKeys.add(key)
			}
			match = errorKeyPattern.exec(content)
		}
	}

	return Array.from(errorKeys).sort()
}

/** Generate error keys from constraints file */
export function generateTranslations(constraintsPath: string, config: TranslationsConfig, cwd: string): void {
	const baseDir = path.resolve(cwd, config.baseDir)

	const translationsDir = path.join(baseDir, "translations", "error-keys")
	ensureDir(translationsDir)

	const dbName = extractDbNameFromConstraints(constraintsPath)
	const errorKeys = extractErrorKeys(constraintsPath)

	if (errorKeys.length === 0) {
		console.error("Warning: No error keys found in constraints file")
		return
	}

	/* Derive file prefix from constraints file name */
	const constraintsBasename = path.basename(constraintsPath)
	const filePrefix = constraintsBasename.replace(/\.constraints\.gen\.ts$/, "")

	/* Write all generated files */
	const errorsFile = path.join(baseDir, `${filePrefix}.error-keys.gen.ts`)
	const enTranslationFile = path.join(translationsDir, `${filePrefix}.error-keys.en.gen.ts`)

	writeGenFile(errorsFile, generateErrorKeysFile(errorKeys, dbName), "comb")
	writeGenFile(enTranslationFile, generateTranslationTs(errorKeys, "en-US", dbName, filePrefix), "comb")

	console.log(`Generated error translations for ${dbName} database`)
	console.log(`Error keys: ${errorKeys.length}`)
}

/** Generate error keys TypeScript file */
function generateErrorKeysFile(keys: string[], dbName: string): string {
	const lines: string[] = []
	const constName = `${toScreamingSnakeCase(dbName)}_DB_ERROR_KEYS`
	const typeName = `${dbName.charAt(0).toUpperCase() + dbName.slice(1)}DbErrorKey`

	lines.push(`const ${constName} = {`)

	for (let index = 0; index < keys.length; index++) {
		const key = keys[index]
		if (key === undefined) continue
		lines.push(`\t${key}: "${key}"${index < keys.length - 1 ? "," : ""}`)
	}

	lines.push("} as const")
	lines.push("")
	lines.push(`type ${typeName} = keyof typeof ${constName}`)
	lines.push("")
	lines.push(`export { ${constName}, type ${typeName} }`)
	lines.push("")

	return lines.join("\n")
}

/** Generate translation TypeScript file */
function generateTranslationTs(keys: string[], locale: string, dbName: string, filePrefix: string): string {
	const lines: string[] = []
	const translations: Record<string, string> = {}

	for (const key of keys) {
		translations[key] = errorKeyToEnglishMessage(key)
	}

	const constName = `${toScreamingSnakeCase(dbName)}_DB_ERROR_KEYS`
	const exportName = `${constName}_${locale.split("-")[0]?.toUpperCase() ?? "EN"}`

	lines.push(`import type { ${constName} } from "../../${filePrefix}.error-keys.gen"`)
	lines.push("")
	lines.push(`const ${exportName}: Record<keyof typeof ${constName}, string> = {`)

	const entries = Object.entries(translations)
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]
		if (!entry) continue
		const [key, value] = entry
		lines.push(`\t${key}: "${value}"${index < entries.length - 1 ? "," : ""}`)
	}

	lines.push("} as const")
	lines.push("")
	lines.push(`export { ${exportName} }`)
	lines.push("")

	return lines.join("\n")
}
