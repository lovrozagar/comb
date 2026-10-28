/** The names generated files derive from paths: a database's from its tables file, and import specifiers */
import path from "node:path"

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
	/* plain pattern, the README's layout: core.tables.ts -> core */
	const plainMatch = fileName.match(/^(\w+)\.tables\./)
	if (plainMatch?.[1] !== undefined) return plainMatch[1]
	return "db"
}

/**
 * How the consumer's TypeScript takes a relative import of a TypeScript file (F53): under `node16`
 * and `nodenext` with its extension, `.js` for `.ts` (the `.ts` itself under
 * `allowImportingTsExtensions` or `rewriteRelativeImportExtensions`); under `bundler` or the older
 * resolutions without one, as comb always wrote it
 */
export type ImportStyle = "bare" | "js" | "ts"

/** The style the consumer's compiler options take */
export function importStyleOf(options: {
	allowImportingTsExtensions?: boolean | undefined
	moduleResolution?: number | undefined
	rewriteRelativeImportExtensions?: boolean | undefined
}): ImportStyle {
	/* ts.ModuleResolutionKind's Node16 and NodeNext */
	if (options.moduleResolution !== 3 && options.moduleResolution !== 99) return "bare"
	return options.allowImportingTsExtensions === true || options.rewriteRelativeImportExtensions === true ? "ts" : "js"
}

/** `specifier`, which names a TypeScript file of `extension` by its path without it, in `style` (none given: bare) */
export function styled(specifier: string, style: ImportStyle | undefined, extension = ".ts"): string {
	if (style === "ts") return `${specifier}${extension}`
	if (style === "js") return `${specifier}${extension.replace(/ts$/, "js")}`
	return extension === ".ts" ? specifier : `${specifier}${extension}`
}

/** The specifier a file in `fromDir` imports `target` by, relative, `./` or `../` first, in `style`; a JavaScript file as it is */
export function specifierFor(fromDir: string, target: string, style: ImportStyle | undefined): string {
	const relative = path.relative(fromDir, target).split(path.sep).join("/")
	const local = relative.startsWith(".") ? relative : `./${relative}`
	const source = /(?<!\.d)(\.[cm]?ts)$/.exec(local)
	return source === null ? local : styled(local.slice(0, -(source[1] as string).length), style, source[1])
}

/** The module specifier `fromFile` imports `target` by, in `style` */
export function importPathFrom(fromFile: string, target: string, style?: ImportStyle | undefined): string {
	return specifierFor(path.dirname(fromFile), target, style)
}

/**
 * Get the import path for the tables file (without extension), relative to same directory.
 * e.g. test.db.core.tables.gen.ts -> ./test.db.core.tables.gen
 */
export function getTablesImportPath(tablesPath: string): string {
	const basename = path.basename(tablesPath, ".ts")
	return `./${basename}`
}
