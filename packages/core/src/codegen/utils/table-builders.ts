/**
 * Which calls in a tables file declare a table. Drizzle's `sqliteTable` and `pgTable` count under
 * whatever local name the file imports them as; `createTable` counts as it always has.
 */
import type { SourceFile } from "ts-morph"

const DRIZZLE_CORE = /^drizzle-orm\/(?:sqlite|pg)-core$/
// lookup-table: drizzle-orm table builder export names
const DRIZZLE_BUILDERS = /* @__PURE__ */ new Set(["sqliteTable", "pgTable"])

/** The local names that declare a table in `file`. */
export function tableBuilders(file: SourceFile): Set<string> {
	return new Set(["createTable", ...builderDialects(file).keys()])
}

/** Each local name `file` imports drizzle's sqliteTable or pgTable as, with the engine it builds for */
export function builderDialects(file: SourceFile): Map<string, "postgres" | "sqlite"> {
	const dialects = new Map<string, "postgres" | "sqlite">()
	for (const declaration of file.getImportDeclarations()) {
		if (!DRIZZLE_CORE.test(declaration.getModuleSpecifierValue())) continue
		for (const named of declaration.getNamedImports()) {
			if (!DRIZZLE_BUILDERS.has(named.getName())) continue
			const local = named.getAliasNode()?.getText() ?? named.getName()
			dialects.set(local, named.getName() === "pgTable" ? "postgres" : "sqlite")
		}
	}
	return dialects
}

/** The callee of a table definition's initializer, if it is a call */
export const calleeOf = (text: string): string | undefined => /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text)?.[1]

/** Whether an initializer's text is a call to one of `builders`. */
export function isTableDefinition(text: string, builders: ReadonlySet<string>): boolean {
	const callee = calleeOf(text)
	return callee !== undefined && builders.has(callee)
}
