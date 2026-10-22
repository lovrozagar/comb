/**
 * Error translation generator: the error keys of the tables' constraint map and their en-US
 * messages, built from the same analysis as the constraints file, so the two always agree.
 */
import path from "node:path"
import { dbIdentifiers, propertyName, stringLiteral } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"
import { buildConstraintMap, constraintsIn } from "./constraints.ts"
import type { GeneratorContext } from "./context-types.ts"

type TranslationsConfig = {
	baseDir: string
	/** file name stem, the one the constraints file uses */
	filePrefix: string
}

/** One error key the constraint map declares, with the cause the server reports beside it */
type ErrorKey = { cause: string; key: string }

/**
 * The en-US message for a key. A duplicate names its column, or a composite unique its columns, from
 * the cause, since the key alone cannot say where a table name ends and a snake_case column begins.
 */
function englishMessage({ cause, key }: ErrorKey): string {
	if (key.endsWith("_duplicate")) {
		/* a composite unique names its columns together, as its constraint's cause does */
		const columns = /^A record with this (.+) combination already exists$/.exec(cause)?.[1]
		if (columns !== undefined) return `A record with this ${columns.replaceAll("_", " ")} combination already exists`
		const field = /^A record with this (\S+) value already exists$/.exec(cause)?.[1]
		if (field === undefined || field === "id") return "Record with this ID already exists"
		return `A record with this ${field.replaceAll("_", " ")} already exists`
	}
	if (key.endsWith("_reference_not_found")) return "Referenced record does not exist"
	return "An error occurred. Please try again."
}

/** Every error key the tables' constraint map declares, sorted, with its cause */
function errorKeysOf(ctx: GeneratorContext): ErrorKey[] {
	const byKey = new Map(
		constraintsIn(buildConstraintMap(ctx.analysis.tables, ctx.dialect)).map((c) => [c.errorKey, c.cause]),
	)
	/* keys are unique, so no two compare equal */
	return [...byKey].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, cause]) => ({ cause, key }))
}

/** Generate the error keys and their en-US messages from the analyzed tables */
export function generateTranslations(ctx: GeneratorContext, config: TranslationsConfig): void {
	const { dbName } = ctx.analysis
	const baseDir = path.resolve(ctx.cwd, config.baseDir)
	const errorKeys = errorKeysOf(ctx)
	if (errorKeys.length === 0) {
		ctx.warn("Warning: no constraint declares an error key; translations skipped")
		return
	}

	const translationsDir = path.join(baseDir, "translations", "error-keys")
	const file: TranslationFile = { dbName, errorKeys, filePrefix: config.filePrefix }
	writeGenFile(path.join(baseDir, `${config.filePrefix}.error-keys.gen.ts`), generateErrorKeysFile(file), {
		generator: "comb",
		staged: ctx.staged,
	})
	writeGenFile(path.join(translationsDir, `${config.filePrefix}.error-keys.en.gen.ts`), generateEnglishFile(file), {
		generator: "comb",
		staged: ctx.staged,
	})

	ctx.log(`Generated error translations for ${dbName} database`)
	ctx.log(`Error keys: ${errorKeys.length}`)
}

type TranslationFile = { dbName: string; errorKeys: ErrorKey[]; filePrefix: string }

const errorKeysConst = (dbName: string) => `${dbIdentifiers(dbName).constant}_DB_ERROR_KEYS`

/** Generate error keys TypeScript file */
function generateErrorKeysFile({ dbName, errorKeys }: TranslationFile): string {
	const constName = errorKeysConst(dbName)
	const typeName = `${dbIdentifiers(dbName).pascal}DbErrorKey`
	return [
		`const ${constName} = {`,
		errorKeys.map(({ key }) => `\t${propertyName(key)}: ${stringLiteral(key)}`).join(",\n"),
		"} as const",
		"",
		`type ${typeName} = keyof typeof ${constName}`,
		"",
		`export { ${constName}, type ${typeName} }`,
		"",
	].join("\n")
}

/** Generate the en-US translation TypeScript file */
function generateEnglishFile({ dbName, errorKeys, filePrefix }: TranslationFile): string {
	const constName = errorKeysConst(dbName)
	const exportName = `${constName}_EN`
	return [
		`import type { ${constName} } from "../../${filePrefix}.error-keys.gen"`,
		"",
		`const ${exportName}: Record<keyof typeof ${constName}, string> = {`,
		errorKeys.map((entry) => `\t${propertyName(entry.key)}: ${stringLiteral(englishMessage(entry))}`).join(",\n"),
		"} as const",
		"",
		`export { ${exportName} }`,
		"",
	].join("\n")
}
