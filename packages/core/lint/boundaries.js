import { builtinModules } from "node:module"
import manifest from "../package.json" with { type: "json" }
import { srcPath } from "./scope.js"

/* comb ships TypeScript source, so every import in src/ is resolved by the consumer: a package
 * must be one they install (a dependency or a peer), a builtin carries the node: prefix that Bun,
 * Node and workerd all accept, and the features keep the arrows that let each dialect ship alone. */

const NODE_BUILTINS = new Set(builtinModules)
const DECLARED = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])

const SHARED_ROOTS = new Set(["error.ts", "types.ts", "lru.ts", "id.ts", "states.ts"])

/* [from feature, to feature]: imports that would couple a feature to one it must ship without */
const FORBIDDEN = [
	["pg", "sqlite"],
	["migrate", "query"],
	["query", "codegen"],
]

/* the one spawner and the bin shim are the only Bun-hosted code */
const BUN_FILES = new Set(["migrate/core/process.ts", "bin.ts"])

const MESSAGES = {
	bun: "the Bun global belongs to src/migrate/core/process.ts and src/bin.ts",
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

function relativeProblem(rel, spec) {
	const target = resolveRel(rel, spec)
	if (target === null) return MESSAGES.escape
	if (SHARED_ROOTS.has(rel)) return SHARED_ROOTS.has(target) ? null : MESSAGES.shared
	const [from, to] = [featureOf(rel), featureOf(target)]
	const arrow = FORBIDDEN.find(([f, t]) => f === from && t === to)
	return arrow === undefined ? null : `${from} must not import ${to}`
}

function problemOf(rel, spec) {
	if (spec.startsWith(".")) return relativeProblem(rel, spec)
	if (spec.startsWith("node:") || spec.startsWith("bun:")) return null
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
			const problem = problemOf(rel, spec)
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
