import { builtinModules } from "node:module"
import manifest from "../package.json" with { type: "json" }
import { children, srcPath } from "./scope.js"

/* comb ships TypeScript source, so every import in src/ is resolved by the consumer: a package
 * must be one they install (a dependency or a peer), a builtin carries the node: prefix that Bun,
 * Node and workerd all accept, and the features keep the arrows that let each dialect ship alone. */

const NODE_BUILTINS = new Set(builtinModules)
const DECLARED = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)])

const SHARED_ROOTS = new Set(["error.ts", "types.ts", "lru.ts", "id.ts", "states.ts"])

/* runtime code lands in a consumer bundle (Workers, Vite); the tooling (ts-morph, node:fs,
 * child_process) must never come along with it */
const RUNTIME = new Set(["query", "sqlite", "pg", "error", "types", "lru", "id", "states", "meta", "constraint-map"])
const TOOLING = new Set(["codegen", "migrate", "cli", "bin"])

/* [from feature, to feature]: imports that would couple a feature to one it must ship without */
const FORBIDDEN = [
	["pg", "sqlite"],
	["sqlite", "pg"],
	["migrate", "query"],
	["query", "migrate"],
]

/* the one spawner, the bun:sqlite driver and the bin shim are the only Bun-hosted code */
const BUN_FILES = new Set(["migrate/core/process.ts", "migrate/drivers/bun-sqlite.ts", "bin.ts"])

const MESSAGES = {
	bun: "Bun APIs (the Bun global, bun: modules) belong to src/migrate/core/process.ts, src/migrate/drivers/bun-sqlite.ts and src/bin.ts",
	escape: "an import stays inside packages/core/src",
	nodePrefix: "import node builtins with the node: prefix",
	shared: "shared roots (error, types, lru, id, states) import only each other",
	/* K7 of r20 */
	peer: "an optional peer loads through optionalPeer(name, why, () => import(…)) from src/migrate/core/optional-peer.ts, so a project without it is told the package, its range and the install",
	/* K5 of r20 */
	url: "import() takes a URL or a package name: Node reads a bare path as a URL (%20 decodes, # starts a fragment), so pass pathToFileURL(path).href",
}

const OPTIONAL_PEERS = new Set(
	Object.entries(manifest.peerDependenciesMeta)
		.filter(([, meta]) => meta.optional === true)
		.map(([name]) => name),
)

/* modules that import an optional peer by name: the codegen child's ts-morph readers, which run only
 * after codegen/runtime/load.ts resolved ts-morph through resolvePeer, and a test fixture */
const PEER_MODULES = new Set([
	"codegen/runtime/module-graph.ts",
	"codegen/runtime/node-hooks.mjs",
	"codegen/runtime/ts-options.mjs",
	"migrate/__fixtures__/libsql-connection.ts",
])

/** The strings `node` can be, a literal or a name bound to one */
function valuesOf(node, bindings, seen = new Set()) {
	if (node?.type === "Literal") return typeof node.value === "string" ? [node.value] : []
	if (node?.type === "Identifier" && !seen.has(node.name)) {
		const next = new Set([...seen, node.name])
		return (bindings.get(node.name) ?? []).flatMap((value) => valuesOf(value, bindings, next))
	}
	return node?.type?.startsWith("TS") === true ? valuesOf(node.expression, bindings, seen) : []
}

/* `node` is inside the load an optionalPeer(name, why, load) call is handed */
function inOptionalPeer(node) {
	let at = node.parent
	while (at && at.type !== "ArrowFunctionExpression" && at.type !== "FunctionExpression") at = at.parent
	const call = at?.parent
	return call?.type === "CallExpression" && call.callee.name === "optionalPeer" && call.arguments.includes(at)
}

/** Each name the file binds, with what it is bound to: a variable's init, a parameter's default, or null */
function bindingsOf(program) {
	const bindings = new Map()
	const bind = (name, value) => bindings.set(name, [...(bindings.get(name) ?? []), value])
	const visit = (node) => {
		if (node.type === "VariableDeclarator" && node.id.type === "Identifier") bind(node.id.name, node.init)
		for (const param of node.params ?? []) {
			if (param.type === "Identifier") bind(param.name, null)
			if (param.type === "AssignmentPattern" && param.left.type === "Identifier") bind(param.left.name, param.right)
		}
		for (const child of children(node)) visit(child)
	}
	visit(program)
	return bindings
}

/* what import() may take: a literal, a URL's href, or a name every binding of which is one; an import binds a name to nothing it can read */
function isSpecifier(node, bindings, seen = new Set()) {
	switch (node?.type) {
		case "Literal":
			return typeof node.value === "string"
		case "TemplateLiteral":
			/* text after a URL stays in it: `${url.href}?mtime=…` */
			return (
				node.expressions.length === 0 ||
				(node.quasis[0].value.raw === "" && isSpecifier(node.expressions[0], bindings, seen))
			)
		case "MemberExpression":
			return !node.computed && node.property.name === "href"
		case "TSAsExpression":
		case "TSNonNullExpression":
		case "TSSatisfiesExpression":
			return isSpecifier(node.expression, bindings, seen)
		case "Identifier":
			return isBoundToSpecifier(node.name, bindings, seen)
		default:
			return false
	}
}

function isBoundToSpecifier(name, bindings, seen) {
	const bound = bindings.get(name) ?? []
	if (bound.length === 0 || seen.has(name)) return false
	const next = new Set([...seen, name])
	return bound.every((value) => isSpecifier(value, bindings, next))
}

const programOf = (node) => (node.parent ? programOf(node.parent) : node)

/** The src-relative path `spec` points at from `rel`, or null when it climbs out of src. */
function resolveRel(rel, spec) {
	const parts = rel.split("/").slice(0, -1)
	for (const part of spec.split("/")) {
		if (part === "" || part === ".") continue
		if (part !== "..") parts.push(part)
		else if (parts.pop() === undefined) return null
	}
	return parts.join("/")
}

const featureOf = (rel) => rel.split("/")[0].replace(/\.ts$/, "")

function packageName(spec) {
	const parts = spec.split("/")
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

/* a type-only import is erased before it runs, so it couples no runtime code */
function typeOnly(node) {
	if (node.importKind === "type" || node.exportKind === "type") return true
	const specifiers = node.specifiers ?? []
	return specifiers.length > 0 && specifiers.every((s) => s.importKind === "type" || s.exportKind === "type")
}

function arrowProblem(rel, target) {
	if (SHARED_ROOTS.has(rel)) return SHARED_ROOTS.has(target) ? null : MESSAGES.shared
	const [from, to] = [featureOf(rel), featureOf(target)]
	const toTooling = RUNTIME.has(from) && TOOLING.has(to)
	const forbidden = toTooling || FORBIDDEN.some(([f, t]) => f === from && t === to)
	return forbidden ? `${from} must not import ${to}` : null
}

function relativeProblem(rel, spec, node) {
	const target = resolveRel(rel, spec)
	if (target === null) return MESSAGES.escape
	return typeOnly(node) ? null : arrowProblem(rel, target)
}

function problemOf(rel, spec, node) {
	if (spec.startsWith(".")) return relativeProblem(rel, spec, node)
	if (spec.startsWith("bun:")) return BUN_FILES.has(rel) ? null : MESSAGES.bun
	if (spec.startsWith("node:")) return null
	if (NODE_BUILTINS.has(spec.split("/")[0])) return MESSAGES.nodePrefix
	const name = packageName(spec)
	if (DECLARED.has(name)) return null
	return `${name} is not in dependencies or peerDependencies of packages/core/package.json`
}

export const rule = {
	create(context) {
		const rel = srcPath(context.filename)
		if (rel === null) return {}
		const checkSource = (node) => {
			const spec = node.source?.type === "Literal" ? node.source.value : null
			if (typeof spec !== "string") return
			const problem = problemOf(rel, spec, node)
			if (problem !== null) context.report({ message: problem, node })
		}
		const checkStatic = (node) => {
			checkSource(node)
			const spec = node.source?.value
			const peer = typeof spec === "string" && OPTIONAL_PEERS.has(packageName(spec))
			if (peer && !typeOnly(node) && !PEER_MODULES.has(rel)) context.report({ message: MESSAGES.peer, node })
		}
		let bindings
		const checkImport = (node) => {
			checkSource(node)
			bindings ??= bindingsOf(programOf(node))
			if (!isSpecifier(node.source, bindings)) context.report({ message: MESSAGES.url, node })
			const peer = valuesOf(node.source, bindings).some((value) => OPTIONAL_PEERS.has(packageName(value)))
			if (peer && !inOptionalPeer(node)) context.report({ message: MESSAGES.peer, node })
		}
		const checkBun = (node, identifier) => {
			if (identifier?.type !== "Identifier" || identifier.name !== "Bun" || BUN_FILES.has(rel)) return
			context.report({ message: MESSAGES.bun, node })
		}
		return {
			ExportAllDeclaration: checkStatic,
			ExportNamedDeclaration: checkStatic,
			ImportDeclaration: checkStatic,
			ImportExpression: checkImport,
			MemberExpression: (node) => checkBun(node, node.object),
			UnaryExpression: (node) => node.operator === "typeof" && checkBun(node, node.argument),
		}
	},
}
