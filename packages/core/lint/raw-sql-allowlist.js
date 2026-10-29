import { srcPath } from "./scope.js"

/* sql.raw is the one injection vector in a parameterized query builder. It stays in the three
 * builders that need it, and what it splices in is fixed text, an identifier quoteIdent quoted, or
 * a count countText or an integer integerText checked to be digits. */
const FILES = new Set(["query/sqlite/search.ts", "query/sqlite/keyset.ts", "query/sqlite/filter-sql.ts"])

const PLACE = "sql.raw belongs to query/sqlite/{search,keyset,filter-sql}.ts; build the query with sql``"
const ARG =
	"sql.raw takes a string literal, a ternary of string literals, quoteIdent(…), countText(…) or integerText(…)"
const SANCTIONED = new Set(["countText", "integerText", "quoteIdent"])

function isFixedText(node) {
	if (node.type === "Literal") return typeof node.value === "string"
	if (node.type === "TemplateLiteral") return node.expressions.length === 0
	if (node.type === "ConditionalExpression") return isFixedText(node.consequent) && isFixedText(node.alternate)
	return false
}

/* `node` is the one argument: the caller has already refused any other count */
function isSafe(node) {
	if (node.type === "CallExpression") return node.callee.type === "Identifier" && SANCTIONED.has(node.callee.name)
	return isFixedText(node)
}

const isSqlRaw = (node) =>
	node.object.type === "Identifier" &&
	node.object.name === "sql" &&
	!node.computed &&
	node.property.type === "Identifier" &&
	node.property.name === "raw"

export const rule = {
	create(context) {
		const path = srcPath(context.filename)
		if (path === null) return {}
		return {
			MemberExpression(node) {
				if (!isSqlRaw(node)) return
				if (!FILES.has(path)) return context.report({ message: PLACE, node })
				const call = node.parent
				const called = call?.type === "CallExpression" && call.callee === node
				if (!called || call.arguments.length !== 1 || !isSafe(call.arguments[0])) {
					context.report({ message: ARG, node })
				}
			},
		}
	},
}
