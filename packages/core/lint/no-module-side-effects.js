import { children, srcPath } from "./scope.js"

/* `"sideEffects": false` is only true when importing a module runs nothing. A bundler keeps any
 * top-level code it cannot prove pure, so module scope only declares; a call it needs is marked
 * pure for the bundler or moved into a function. */
const MESSAGE = "module scope runs no code: mark a pure call /* @__PURE__ */ or move it into a function"

const DECLARATIONS = new Set([
	"ClassDeclaration",
	"EmptyStatement",
	"ExportAllDeclaration",
	"FunctionDeclaration",
	"ImportDeclaration",
	"TSDeclareFunction",
	"TSEnumDeclaration",
	"TSExportAssignment",
	"TSImportEqualsDeclaration",
	"TSInterfaceDeclaration",
	"TSModuleDeclaration",
	"TSTypeAliasDeclaration",
])

const EFFECTS = new Set([
	"AssignmentExpression",
	"AwaitExpression",
	"CallExpression",
	"NewExpression",
	"TaggedTemplateExpression",
	"UpdateExpression",
	"YieldExpression",
])

/* code inside these runs later, when called, not at import */
const DEFERRED = new Set(["ArrowFunctionExpression", "ClassExpression", "FunctionExpression"])

const PURE = /[@#]__PURE__/

/** The first node under `node` that runs code at import, ignoring pure-marked calls. */
function firstEffect(context, node) {
	if (node === null || node === undefined || DEFERRED.has(node.type)) return null
	if (EFFECTS.has(node.type)) {
		const pure = context.sourceCode.getCommentsBefore(node).some((comment) => PURE.test(comment.value))
		if (!pure) return node
	}
	for (const child of children(node)) {
		const found = firstEffect(context, child)
		if (found !== null) return found
	}
	return null
}

function reportEffect(context, node) {
	const effect = firstEffect(context, node)
	if (effect !== null) context.report({ message: MESSAGE, node: effect })
}

function check(context, statement) {
	const inner = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
	if (inner === null || inner === undefined || DECLARATIONS.has(inner.type)) return
	if (inner.type === "ExpressionStatement" && typeof inner.directive === "string") return
	if (inner.type === "VariableDeclaration") {
		for (const declarator of inner.declarations) reportEffect(context, declarator.init)
		return
	}
	if (inner.type === "ExportDefaultDeclaration") return reportEffect(context, inner.declaration)
	context.report({ message: MESSAGE, node: inner })
}

export const rule = {
	create(context) {
		const path = srcPath(context.filename)
		/* the executable exists to run: bin.ts is the one module whose import is the side effect */
		if (path === null || path === "bin.ts") return {}
		return {
			Program(program) {
				for (const statement of program.body) check(context, statement)
			},
		}
	},
}
