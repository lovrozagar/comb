import { dirname, join } from "node:path/posix"

/*
 * The generic aliases, interfaces and classes a source file names, each with the file that declares it,
 * however src exports and imports it (D4-2 of the area D round-four review): a declaration of its
 * own; a named or default import, under its own name or another; a namespace import read as
 * `A.Name`; an import type, `import("./file.ts").Name`, read as a named import of that file (D5-3 of
 * round five); through an export list, a default export, a re-export or a barrel's `export *`. An import
 * resolves through the one file its relative specifier names, as written; a package's names no file
 * of src. Paths are posix, as the rule keys every file. A namespace re-export, `export * as N from`,
 * resolves to nothing: a name imported from it and read as `N.Name` finds no generic, so its type
 * arguments flow as written. src holds no such re-export.
 */

/* the declarations that are a generic alias, interface or class (D5-3 of the area D round-five review) */
const GENERIC = new Set(["ClassDeclaration", "TSInterfaceDeclaration", "TSTypeAliasDeclaration"])
const genericOf = (node) => (GENERIC.has(node?.type) && node.typeParameters ? node : null)

/** The file a relative `source` of `file` names, as written; null for a package's */
const target = (file, source) => (source.value.startsWith(".") ? join(dirname(file), source.value) : null)

/** The generics `program` declares at its top, exported or not, each as { declared, file } by name */
function declaredIn(program, file) {
	const declared = new Map()
	for (const node of program.body) {
		const generic = genericOf(node.type === "ExportNamedDeclaration" ? node.declaration : node)
		if (generic) declared.set(generic.id.name, { declared: generic, file })
	}
	return declared
}

/** What each name `program` imports from a file of src stands for: { file, name } named, or the file a namespace is */
function importsIn(program, file) {
	const named = new Map()
	const namespaces = new Map()
	for (const node of program.body) {
		const from = node.type === "ImportDeclaration" ? target(file, node.source) : null
		if (from === null) continue
		for (const spec of node.specifiers) {
			if (spec.type === "ImportNamespaceSpecifier") namespaces.set(spec.local.name, from)
			else named.set(spec.local.name, { file: from, name: spec.imported?.name ?? "default" })
		}
	}
	return { named, namespaces }
}

/**
 * What each name `program` exports stands for, a generic of its own or the { file, name } it passes
 * on, and the files its `export *` passes on whole; `standsFor` gives what a name of its own stands for
 */
function exportsIn(program, file, standsFor) {
	const exported = new Map()
	const stars = []
	for (const node of program.body) {
		const from = node.source ? target(file, node.source) : undefined
		if (node.type === "ExportAllDeclaration" && from && node.exported === null) stars.push(from)
		if (node.type === "ExportDefaultDeclaration" && genericOf(node.declaration))
			exported.set("default", { declared: node.declaration, file })
		if (node.type !== "ExportNamedDeclaration" || from === null) continue
		const own = genericOf(node.declaration)
		if (own) exported.set(own.id.name, { declared: own, file })
		for (const { exported: as, local } of node.specifiers)
			exported.set(as.name, from ? { file: from, name: local.name } : standsFor(local.name))
	}
	return { exported, stars }
}

/** `program` of `file`: what it declares, imports and exports */
export function moduleOf(program, file) {
	const declared = declaredIn(program, file)
	const { named, namespaces } = importsIn(program, file)
	const standsFor = (name) => declared.get(name) ?? named.get(name)
	return { declared, file, named, namespaces, ...exportsIn(program, file, standsFor) }
}

/** The generic `entry` stands for, followed through the files `modules` holds; undefined when none */
function resolve(entry, modules, seen = new Set()) {
	if (entry === undefined || entry.declared !== undefined) return entry
	const key = `${entry.file}\0${entry.name}`
	const module = modules.get(entry.file)
	if (module === undefined || seen.has(key)) return undefined
	const followed = new Set([...seen, key])
	/* `export *` passes on every name but the default */
	if (module.exported.has(entry.name) || entry.name === "default")
		return resolve(module.exported.get(entry.name), modules, followed)
	for (const file of module.stars) {
		const generic = resolve({ file, name: entry.name }, modules, followed)
		if (generic) return generic
	}
	return undefined
}

/* how optional-undefined.js names an import type: `import("./file.ts").Name` */
const IMPORTED = /^import\("(.*)"\)\.(.+)$/

/** Looks up the generic `module` names by `name` (`A.Name` through a namespace, `import("…").Name`), as { declared, file }; undefined when none */
export function scopeOf(module, modules) {
	return (name) => {
		const imported = IMPORTED.exec(name)
		const from = imported && target(module.file, { value: imported[1] })
		if (imported) return from === null ? undefined : resolve({ file: from, name: imported[2] }, modules)
		const own = module.declared.get(name) ?? resolve(module.named.get(name), modules)
		const dot = name.indexOf(".")
		const namespace = dot === -1 ? undefined : module.namespaces.get(name.slice(0, dot))
		return own ?? (namespace && resolve({ file: namespace, name: name.slice(dot + 1) }, modules))
	}
}
