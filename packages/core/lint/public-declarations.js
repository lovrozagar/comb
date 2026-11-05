/* What a declaration shows a consumer, read off the syntax: shared by the surface graph and comb/public-jsdoc. */

// lookup-table: the nodes whose body a consumer does not see
const FUNCTIONS = new Set(["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"])
// lookup-table: the nodes whose value shows only when it is typed
const VALUE_HOLDERS = new Set(["AccessorProperty", "PropertyDefinition", "VariableDeclarator"])
// lookup-table: the values that state their own type
const TYPED_INITS = new Set([
	"ArrowFunctionExpression",
	"FunctionExpression",
	"TSAsExpression",
	"TSSatisfiesExpression",
])

/** A member a consumer cannot reach. */
export function isHiddenMember(node) {
	if (node.accessibility === "private" || node.accessibility === "protected") return true
	return node.key?.type === "PrivateIdentifier"
}

function skipsChild(node, key) {
	if (key === "parent") return true
	if (FUNCTIONS.has(node.type)) return key === "body"
	if (node.type === "AssignmentPattern") return key === "right"
	if (VALUE_HOLDERS.has(node.type)) {
		const value = node.type === "VariableDeclarator" ? "init" : "value"
		return key === value && !TYPED_INITS.has(node[key]?.type)
	}
	return false
}

/** Walks what a declaration shows a consumer: no function body, no private member, no untyped initializer. */
export function walkPublic(node, visit) {
	if (Array.isArray(node)) {
		for (const child of node) walkPublic(child, visit)
		return
	}
	if (typeof node !== "object" || node === null || typeof node.type !== "string" || isHiddenMember(node)) return
	if (visit(node) === false) return
	for (const [key, value] of Object.entries(node)) {
		if (!skipsChild(node, key)) walkPublic(value, visit)
	}
}

/** The declaration an export statement carries, or the statement itself. */
export function declarationOf(statement) {
	const exporting = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
	return exporting ? (statement.declaration ?? null) : statement
}

/** The top-level names a statement declares. */
export function declaredNames(statement) {
	const declaration = declarationOf(statement)
	if (declaration === null) return []
	if (declaration.type === "VariableDeclaration") {
		return declaration.declarations.filter((d) => d.id.type === "Identifier").map((d) => d.id.name)
	}
	if (!/Declaration$|^TSDeclareFunction$/.test(declaration.type) || declaration.id === undefined) return []
	if (declaration.type === "TSModuleDeclaration") return []
	if (declaration.id === null) return ["default"]
	return [declaration.id.name]
}
