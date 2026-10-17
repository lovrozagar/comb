import { children, srcPath } from "./scope.js"

/* In a migration runner a swallowed error is a half-applied schema reported as success. Every
 * catch hands the failure on (rethrows, or returns or throws it converted), reports it, or says
 * why there is nothing to report. */
const MESSAGE = "a catch rethrows, returns or throws the converted error, calls a reporter, or says `// reason: <why>`"

const REPORTER = /^(?:report\w*|onError|log|warn|error|fatal)$/
const REASON = /^reason:\s*\S/
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"])

function mentions(node, name) {
	if (node === null || node === undefined || name === null) return false
	if (node.type === "Identifier" && node.name === name) return true
	return children(node).some((child) => mentions(child, name))
}

function calleeName(callee) {
	if (callee.type === "Identifier") return callee.name
	if (callee.type === "MemberExpression" && callee.property.type === "Identifier") return callee.property.name
	return ""
}

/** True when `node` (not descending into nested functions) hands on or reports the error `name`. */
function accounts(node, name) {
	if (node.type === "ThrowStatement") return true
	if (node.type === "ReturnStatement") return mentions(node.argument, name)
	if (node.type === "CallExpression" && REPORTER.test(calleeName(node.callee))) return true
	return children(node).some((child) => !FUNCTIONS.has(child.type) && accounts(child, name))
}

function hasReason(context, node) {
	const text = context.sourceCode.getText()
	const lineOf = (offset) => text.slice(0, offset).split("\n").length
	const first = lineOf(node.start) - 1
	const last = lineOf(node.end)
	return context.sourceCode.getAllComments().some((comment) => {
		const line = lineOf(comment.start)
		return line >= first && line <= last && REASON.test(comment.value.trim())
	})
}

const paramName = (param) => (param?.type === "Identifier" ? param.name : null)

function handled(handler) {
	if (!FUNCTIONS.has(handler?.type)) return false
	const name = paramName(handler.params[0])
	if (handler.body.type !== "BlockStatement") return mentions(handler.body, name) || accounts(handler.body, name)
	return accounts(handler.body, name)
}

export const rule = {
	create(context) {
		if (srcPath(context.filename) === null) return {}
		const check = (node, ok) => {
			if (!ok && !hasReason(context, node)) context.report({ message: MESSAGE, node })
		}
		return {
			CatchClause: (node) => check(node, accounts(node.body, paramName(node.param))),
			CallExpression(node) {
				if (calleeName(node.callee) !== "catch" || node.callee.type !== "MemberExpression") return
				check(node, handled(node.arguments[0]))
			},
		}
	},
}
