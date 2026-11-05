import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { declarationOf, walkPublic } from "./public-declarations.js"
import { parseModule } from "./public-module.js"

/* What a package exposes: every declaration its `exports` entries reach, by name or through a type position. It is
 * read off the syntax, so oxlint can ask for it, and anything the walk cannot follow lands in `unknown` for the rule to
 * report: a form skipped in silence would pass a public gap. */

/* comb ships its TypeScript source: an entry's `default` condition names the file under ./src/ a consumer's editor
 * reads, and only those entries are its documented surface */
const CONDITION = "default"
const SOURCE_DIR = "./src/"

function readManifest(dir) {
	const path = join(dir, "package.json")
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
}

/* the source file an `exports` entry's default condition names under ./src/, or null */
function sourceOf(value) {
	const target = typeof value === "object" && value !== null ? value[CONDITION] : undefined
	return typeof target === "string" && target.startsWith(SOURCE_DIR) ? target : null
}

function usesCondition(manifest) {
	return Object.values(manifest?.exports ?? {}).some((value) => sourceOf(value) !== null)
}

/** The nearest package above `filename` with an `exports` entry whose default condition points into ./src/, or null. */
export function findPackageRoot(filename) {
	for (let dir = dirname(filename); dir !== dirname(dir); dir = dirname(dir)) {
		if (usesCondition(readManifest(dir))) return dir
	}
	return null
}

function moduleOf(graph, file) {
	if (!graph.modules.has(file)) graph.modules.set(file, existsSync(file) ? parseModule(file) : null)
	return graph.modules.get(file)
}

/* `found` is the form the walk cannot follow and the node it starts at; a form two routes reach is reported once */
function fail(graph, module, { form, node }) {
	failAt(graph, { file: module.file, form, line: module.code.slice(0, node.start).split("\n").length })
}

function failAt(graph, { file, form, line }) {
	const key = `${file}\0${line}\0${form}`
	if (graph.failed.has(key)) return
	graph.failed.add(key)
	graph.unknown.push({ file, form, line })
}

function targetOf(file, source) {
	return source.startsWith(".") ? resolve(dirname(file), source) : null
}

/* one resolution's state: the graph it reads and the (file, name) pairs it has visited, so a star cycle ends */
function resolution(graph) {
	return { graph, seen: new Set() }
}

/* a name resolves to a declaration in a file, to a whole module, or to null when nothing declares it */
function resolveExport(at, file, name) {
	const visit = `${file}\0${name}`
	if (at.seen.has(visit)) return null
	at.seen.add(visit)
	const module = moduleOf(at.graph, file)
	if (module === null) return null
	const found = module.exports.get(name)
	if (found !== undefined) return resolveEntry(at, module, found)
	if (name === "default") return null
	for (const star of module.stars) {
		const target = targetOf(file, star)
		const resolved = target === null ? null : resolveExport(at, target, name)
		if (resolved !== null) return resolved
	}
	return null
}

function resolveImported(at, module, entry) {
	const target = targetOf(module.file, entry.source)
	if (target === null) return { external: true }
	if (entry.imported !== "*") return resolveExport(at, target, entry.imported)
	return moduleOf(at.graph, target) === null ? null : { module: target }
}

function resolveEntry(at, module, entry) {
	if (entry.source !== undefined) return resolveImported(at, module, entry)
	if (module.locals.has(entry.local)) return { file: module.file, name: entry.local }
	const imported = module.imports.get(entry.local)
	return imported === undefined ? null : resolveImported(at, module, imported)
}

function exportNames(graph, file, seen = new Set()) {
	if (seen.has(file)) return []
	seen.add(file)
	const module = moduleOf(graph, file)
	if (module === null) return []
	const stars = module.stars.flatMap((star) => {
		const target = targetOf(file, star)
		return target === null ? [] : exportNames(graph, target, seen).filter((name) => name !== "default")
	})
	return [...new Set([...module.exports.keys(), ...stars])]
}

function collectReference(references, node) {
	const path = []
	let at = node
	while (at.type === "TSQualifiedName" || at.type === "MemberExpression") {
		path.unshift((at.right ?? at.property).name)
		at = at.left ?? at.object
	}
	if (at.type === "Identifier") references.push({ member: path[0], name: at.name })
	else if (at.type === "TSImportType") collectImportType(references, at)
	else references.push({ unreadable: at })
}

function collectImportType(references, node) {
	references.push({ member: node.qualifier?.name, source: node.source.value })
}

const REFERENCE_KEYS = {
	TSClassImplements: "expression",
	TSInterfaceHeritage: "expression",
	TSTypeQuery: "exprName",
	TSTypeReference: "typeName",
}

function referencesOf(statement) {
	const references = []
	const shadowed = new Set()
	walkPublic(declarationOf(statement), (node) => {
		if (node.type === "TSTypeParameter") shadowed.add(node.name.name)
		if (node.type === "TSImportType") collectImportType(references, node)
		if (node.type === "ClassDeclaration" && node.superClass) collectReference(references, node.superClass)
		const key = REFERENCE_KEYS[node.type]
		if (key !== undefined) collectReference(references, node[key])
	})
	return references.filter((reference) => !shadowed.has(reference.name))
}

/* `walk` is one entry's publishing: the graph it fills and the entry key every name it reaches is recorded under */
function publishResolved(walk, resolved) {
	if (resolved.external) return
	if (resolved.module !== undefined) publishModule(walk, resolved.module)
	else publishName(walk, resolved.file, resolved.name)
}

function publishReference(walk, module, reference) {
	const graph = walk.graph
	const { unreadable } = reference
	if (unreadable !== undefined) return fail(graph, module, { form: unreadable.type, node: unreadable })
	let resolved = null
	if (reference.source !== undefined) {
		const entry = { imported: reference.member ?? "*", source: reference.source }
		resolved = resolveImported(resolution(graph), module, entry)
	} else if (module.locals.has(reference.name)) {
		resolved = { file: module.file, name: reference.name }
	} else {
		const imported = module.imports.get(reference.name)
		if (imported === undefined) return
		const entry = imported.imported === "*" && reference.member ? { ...imported, imported: reference.member } : imported
		resolved = resolveImported(resolution(graph), module, entry)
	}
	if (resolved !== null) publishResolved(walk, resolved)
}

function publishName(walk, file, name) {
	const graph = walk.graph
	const names = graph.names.get(file) ?? new Map()
	graph.names.set(file, names)
	if (names.has(name)) return
	names.set(name, walk.entryKey)
	const module = moduleOf(graph, file)
	for (const found of module.namespaces.get(name) ?? []) fail(graph, module, found)
	for (const statement of module.locals.get(name)) {
		for (const reference of referencesOf(statement)) publishReference(walk, module, reference)
	}
}

/* what `file` and every module its stars reach export but the walk cannot follow, and each star naming no file: a
 * star publishes each name it reaches, so a form it reaches in silence is a public gap */
function failReached(graph, file, seen) {
	if (seen.has(file)) return
	seen.add(file)
	const module = moduleOf(graph, file)
	for (const found of module.unknown) fail(graph, module, found)
	for (const star of module.stars) {
		const target = targetOf(file, star)
		if (target === null) continue
		if (moduleOf(graph, target) === null) failAt(graph, { file, form: star, line: 1 })
		else failReached(graph, target, seen)
	}
}

function publishModule(walk, file) {
	const graph = walk.graph
	const first = !graph.published.has(file)
	graph.published.add(file)
	const module = moduleOf(graph, file)
	if (!first) return
	failReached(graph, file, new Set())
	for (const name of exportNames(graph, file)) {
		const resolved = resolveExport(resolution(graph), file, name)
		if (resolved === null) failExport(graph, module, name)
		else publishResolved(walk, resolved)
	}
}

function failExport(graph, module, name) {
	const entry = module.exports.get(name)
	const missing = entry?.source !== undefined && moduleOf(graph, targetOf(module.file, entry.source)) === null
	graph.unknown.push({ file: module.file, form: missing ? entry.source : name, line: 1 })
}

function publishEntry(walk, root, source) {
	const file = join(root, source)
	if (moduleOf(walk.graph, file) === null) walk.graph.unknown.push({ file, form: source, line: 1 })
	else publishModule(walk, file)
}

function readSurface(root, entries) {
	const graph = { failed: new Set(), modules: new Map(), names: new Map(), published: new Set(), unknown: [] }
	for (const [key, value] of Object.entries(readManifest(root).exports)) {
		const source = sourceOf(value)
		if (source !== null && (entries === null || entries.includes(key)))
			publishEntry({ entryKey: key, graph }, root, source)
	}
	return { names: graph.names, unknown: graph.unknown }
}

// per-process-constant: one lint run reads a package once, and every file's rule run shares that reading
const SURFACES = new Map()

/**
 * The declarations `root` exposes through `entries` (every entry when null), by file, each with the first of them that
 * reaches it, and what could not be read.
 * @param {string} root
 * @param {string[] | null} [entries]
 * @returns {{ names: Map<string, Map<string, string>>, unknown: Array<{ file: string, form: string, line: number }> }}
 */
export function publicSurface(root, entries = null) {
	const key = `${root}\0${entries === null ? "*" : JSON.stringify(entries)}`
	if (!SURFACES.has(key)) SURFACES.set(key, readSurface(root, entries))
	return SURFACES.get(key)
}
