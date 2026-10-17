/**
 * The schemas and consts a generated DTO file needs, and where the tables file gets them, so
 * the generated file imports each one from the same module, relative to wherever it is written.
 */
import path from "node:path"
import { type Node, type SourceFile, SyntaxKind } from "ts-morph"
import type { ImportRef } from "../analyzer-types.ts"
import { callNamed } from "./enum-source.ts"

export type { ImportRef }

export type JsonSchemaSource = {
	/** the schema argument's source text, emitted into the generated DTO as written */
	expression: string
	/** the free identifiers it uses, which the generated file must import */
	names: string[]
}

/* identifiers that name no value: property and member names */
function isValueName(node: Node): boolean {
	const parent = node.getParent()
	if (parent?.isKind(SyntaxKind.PropertyAccessExpression)) return parent.getNameNode() !== node
	if (parent?.isKind(SyntaxKind.PropertyAssignment)) return parent.getNameNode() !== node
	return true
}

/* zod is imported by every generated file as `z` */
// lookup-table: names every generated file already has
const PROVIDED = /* @__PURE__ */ new Set(["z", "undefined"])

function freeIdentifiers(node: Node): string[] {
	const own = node.isKind(SyntaxKind.Identifier) ? [node] : []
	const names = [...own, ...node.getDescendantsOfKind(SyntaxKind.Identifier)]
		.filter(isValueName)
		.map((identifier) => identifier.getText())
		.filter((name) => !PROVIDED.has(name))
	return [...new Set(names)]
}

/** The schema a `c.json(name, schema)` column declares, or null when it is not one or has none. */
export function readJsonSchema(column: Node): JsonSchemaSource | null {
	const schema = callNamed(column, "c.json")?.getArguments()[1]
	if (schema === undefined) return null
	return { expression: schema.getText(), names: freeIdentifiers(schema) }
}

function importedRef(file: SourceFile, name: string): ImportRef | undefined {
	for (const declaration of file.getImportDeclarations()) {
		const from = declaration.getModuleSpecifierValue()
		const resolved = declaration.getModuleSpecifierSourceFile()?.getFilePath() ?? null
		const at = (imported: string): ImportRef => ({ from, imported, name, path: resolved })
		if (declaration.getNamespaceImport()?.getText() === name) return at("*")
		if (declaration.getDefaultImport()?.getText() === name) return at("default")
		const named = declaration.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name)
		if (named !== undefined) return at(named.getName())
	}
	return undefined
}

function localRef(file: SourceFile, name: string): ImportRef | undefined {
	const declaration = file.getVariableDeclaration(name) ?? file.getFunction(name) ?? file.getClass(name)
	/* neither imported nor declared: a global such as Date, which the generated file has too */
	if (declaration === undefined) return undefined
	const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? declaration
	const exported = statement.asKind(SyntaxKind.VariableStatement)?.isExported() ?? declaration.isExported()
	if (!exported) {
		throw new Error(
			`"${name}" is declared in ${file.getFilePath()} without export, so the generated DTOs cannot import it`,
		)
	}
	return { from: `./${path.basename(file.getFilePath(), ".ts")}`, imported: name, name, path: file.getFilePath() }
}

/** Where each of `names` comes from, as `file` sees it; globals are left out. */
export function importRefs(names: readonly string[], file: SourceFile): ImportRef[] {
	return names.flatMap((name) => importedRef(file, name) ?? localRef(file, name) ?? [])
}
