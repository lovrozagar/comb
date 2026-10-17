import { srcPath } from "./scope.js"

/* A module-scope let, var or constructed object is shared by every caller in the process: two
 * concurrent codegen runs or two requests see each other's state. It needs one of the reasons
 * below and a word on why, on its line or the line above. */
const REASON = /^(?:lookup-table|lru-cache|per-process-constant):\s*\S/

const MESSAGE =
	"module-scope state needs `// <reason>: <why>` on its line or the line above, with reason lookup-table, lru-cache or per-process-constant"

const WRAPPERS = new Set(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression"])

function unwrap(node) {
	let current = node
	while (current !== null && current !== undefined && WRAPPERS.has(current.type)) current = current.expression
	return current
}

function isState(declaration) {
	if (declaration.kind !== "const") return true
	return declaration.declarations.some((d) => unwrap(d.init)?.type === "NewExpression")
}

function allowed(context, statement) {
	const text = context.sourceCode.getText()
	const before = context.sourceCode.getCommentsBefore(statement)
	const sameLine = context.sourceCode
		.getCommentsAfter(statement)
		.filter((comment) => !text.slice(statement.end, comment.start).includes("\n"))
	return [...before, ...sameLine].some((comment) => REASON.test(comment.value.trim()))
}

export const rule = {
	create(context) {
		if (srcPath(context.filename) === null) return {}
		return {
			VariableDeclaration(node) {
				const statement = node.parent?.type === "ExportNamedDeclaration" ? node.parent : node
				if (statement.parent?.type !== "Program" || !isState(node)) return
				if (allowed(context, statement)) return
				context.report({ message: MESSAGE, node })
			},
		}
	},
}
