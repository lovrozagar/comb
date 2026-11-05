import { readFileSync } from "node:fs"
import { parseSync } from "oxc-parser"
import { declarationOf, declaredNames } from "./public-declarations.js"

/* One module as public-surface.js reads it: what it imports, exports and declares at the top level, read off the syntax.
 * A form the surface walk cannot follow lands in `unknown`, so the rule reports it rather than passing a gap. */

function unknownForm(statement, declaration) {
	if (statement.type === "TSExportAssignment") return statement.type
	if (statement.type === "ExportNamedDeclaration" && declaration !== null) {
		if (declaration.type === "TSModuleDeclaration" || declaration.type === "TSImportEqualsDeclaration") {
			return declaration.type
		}
		if (declaration.type === "VariableDeclaration") {
			return declaration.declarations.find((d) => d.id.type !== "Identifier")?.id.type ?? null
		}
	}
	return null
}

function addImports(module, statement) {
	for (const specifier of statement.specifiers) {
		const imported =
			specifier.type === "ImportNamespaceSpecifier"
				? "*"
				: specifier.type === "ImportDefaultSpecifier"
					? "default"
					: specifierName(specifier.imported)
		module.imports.set(specifier.local.name, { imported, source: statement.source.value })
	}
}

function specifierName(node) {
	return node.type === "Literal" ? node.value : node.name
}

function addExports(module, statement) {
	const source = statement.source?.value
	if (statement.type === "ExportAllDeclaration") {
		if (statement.exported) module.exports.set(specifierName(statement.exported), { imported: "*", source })
		else module.stars.push(source)
		return
	}
	if (statement.type === "ExportDefaultDeclaration") {
		const declaration = statement.declaration
		const names = declaredNames(statement)
		if (names.length > 0) module.exports.set("default", { local: names[0] })
		else if (declaration.type === "Identifier") module.exports.set("default", { local: declaration.name })
		else module.unknown.push({ form: declaration.type, node: statement })
		return
	}
	for (const name of declaredNames(statement)) module.exports.set(name, { local: name })
	for (const specifier of statement.specifiers) {
		const local = specifierName(specifier.local)
		const entry = source === undefined ? { local } : { imported: local, source }
		module.exports.set(specifierName(specifier.exported), entry)
	}
}

function addLocals(module, statement) {
	for (const name of declaredNames(statement)) {
		const declarations = module.locals.get(name) ?? []
		declarations.push(statement)
		module.locals.set(name, declarations)
	}
}

/* a namespace, exported or not, merges into the function, class or enum of its name, which then exposes its members
 * where the walk cannot follow them */
function addNamespace(module, statement) {
	const declaration = declarationOf(statement)
	if (declaration?.type !== "TSModuleDeclaration" || declaration.id.type !== "Identifier") return
	const found = module.namespaces.get(declaration.id.name) ?? []
	found.push({ form: declaration.type, node: statement })
	module.namespaces.set(declaration.id.name, found)
}

/** One file's imports, exports, top-level declarations, namespaces, `export *` sources, and the exported forms the
 * surface walk cannot follow. */
export function parseModule(file) {
	const code = readFileSync(file, "utf8")
	const module = {
		code,
		exports: new Map(),
		file,
		imports: new Map(),
		locals: new Map(),
		namespaces: new Map(),
		stars: [],
		unknown: [],
	}
	for (const statement of parseSync(file, code).program.body) {
		if (statement.type === "ImportDeclaration") addImports(module, statement)
		if (statement.type.startsWith("Export")) addExports(module, statement)
		addLocals(module, statement)
		addNamespace(module, statement)
		const form = unknownForm(statement, declarationOf(statement))
		if (form !== null) module.unknown.push({ form, node: statement })
	}
	return module
}
