/**
 * Which calls in a tables file declare a table. Drizzle's `sqliteTable` and `pgTable` count under
 * whatever local name the file imports them as; `createTable` counts as it always has.
 */
import type { SourceFile } from "ts-morph"

const DRIZZLE_CORE = /^drizzle-orm\/(?:sqlite|pg)-core$/
const DRIZZLE_BUILDERS = new Set(["sqliteTable", "pgTable"])

/** The local names that declare a table in `file`. */
export function tableBuilders(file: SourceFile): Set<string> {
	const names = new Set(["createTable"])
	for (const declaration of file.getImportDeclarations()) {
		if (!DRIZZLE_CORE.test(declaration.getModuleSpecifierValue())) continue
		for (const named of declaration.getNamedImports()) {
			if (DRIZZLE_BUILDERS.has(named.getName())) names.add(named.getAliasNode()?.getText() ?? named.getName())
		}
	}
	return names
}

/** Whether an initializer's text is a call to one of `builders`. */
export function isTableDefinition(text: string, builders: ReadonlySet<string>): boolean {
	const callee = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text)?.[1]
	return callee !== undefined && builders.has(callee)
}
