import { builtinModules } from "node:module"
import manifest from "../package.json" with { type: "json" }
import { srcPath } from "./scope.js"

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
}

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
		const checkBun = (node, identifier) => {
			if (identifier?.type !== "Identifier" || identifier.name !== "Bun" || BUN_FILES.has(rel)) return
			context.report({ message: MESSAGES.bun, node })
		}
		return {
			ExportAllDeclaration: checkSource,
			ExportNamedDeclaration: checkSource,
			ImportDeclaration: checkSource,
			ImportExpression: checkSource,
			MemberExpression: (node) => checkBun(node, node.object),
			UnaryExpression: (node) => node.operator === "typeof" && checkBun(node, node.argument),
		}
	},
}
