/**
 * An enum column's values and state machine, read from the AST the way TypeScript sees them:
 * an inline list (with `as const`, across lines), a const in the same file, a const imported
 * from a file in the project, a machine's `.values`, and a machine passed by reference or declared
 * through `defineStateMachine`.
 */
import { placeOf } from "./node-text.ts"
import { type CallExpression, type Node, type ObjectLiteralExpression, SyntaxKind } from "ts-morph"
import type { StateMachineMeta } from "../analyzer-types.ts"

export type EnumSource = {
	machine: StateMachineMeta | null
	/** the identifier the values come from, when they could not be read */
	reference: string | null
	values: string[] | null
}

// lookup-table: the expression kinds that only wrap another expression
const WRAPPERS = /* @__PURE__ */ new Set([
	SyntaxKind.AsExpression,
	SyntaxKind.NonNullExpression,
	SyntaxKind.ParenthesizedExpression,
	SyntaxKind.SatisfiesExpression,
	SyntaxKind.TypeAssertionExpression,
])

const MAX_HOPS = 8

/** `defineStateMachine(m)` from `@lovrozagar/comb/states` returns `m`: the analyzer reads through it */
const IDENTITY_CALL = "defineStateMachine"

function unwrap(node: Node): Node {
	let current = node
	while (WRAPPERS.has(current.getKind())) current = (current as unknown as { getExpression(): Node }).getExpression()
	return current
}

/**
 * The initializer of the const an identifier names, following an import to its source. A let or a
 * var may hold another value at runtime than its initializer, so it is refused, as the constant
 * reader refuses it (F34).
 */
function definitionOf(node: Node): Node | undefined {
	const symbol = node.getSymbol()
	const target = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol
	const declaration = target?.getDeclarations()[0]?.asKind(SyntaxKind.VariableDeclaration)
	const kind = declaration?.getVariableStatement()?.getDeclarationKind()
	if (kind !== undefined && kind !== "const")
		throw new Error(
			`${placeOf(node)}: ${node.getText()} is declared with ${kind}, not const, so comb cannot know its value; declare it const`,
		)
	return declaration?.getInitializer()
}

/** The expression `node` stands for, through consts and property accesses. */
export function resolve(node: Node | undefined, hops = 0): Node | undefined {
	if (node === undefined || hops > MAX_HOPS) return undefined
	const bare = unwrap(node)
	if (bare.isKind(SyntaxKind.Identifier)) return resolve(definitionOf(bare), hops + 1)
	if (bare.isKind(SyntaxKind.PropertyAccessExpression)) {
		const owner = resolve(bare.getExpression(), hops + 1)?.asKind(SyntaxKind.ObjectLiteralExpression)
		return resolve(propertyValue(owner, bare.getName()), hops + 1)
	}
	const call = bare.asKind(SyntaxKind.CallExpression)
	if (call?.getExpression().getText() === IDENTITY_CALL) return resolve(call.getArguments()[0], hops + 1)
	return bare
}

function keyOf(property: Node): string | undefined {
	const name = property.asKind(SyntaxKind.PropertyAssignment)?.getNameNode()
	if (name === undefined) return undefined
	return name.isKind(SyntaxKind.StringLiteral) ? name.getLiteralValue() : name.getText()
}

function propertyValue(object: ObjectLiteralExpression | undefined, key: string): Node | undefined {
	const property = object?.getProperties().find((p) => keyOf(p) === key)
	return property?.asKind(SyntaxKind.PropertyAssignment)?.getInitializer()
}

export function stringOf(node: Node | undefined): string | null {
	const value = resolve(node)
	if (value?.isKind(SyntaxKind.StringLiteral) || value?.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
		return value.getLiteralValue()
	}
	return null
}

/** The strings a list literal holds, or null when any element is not a string literal. */
function stringsOf(node: Node | undefined): string[] | null {
	const list = resolve(node)?.asKind(SyntaxKind.ArrayLiteralExpression)
	if (list === undefined) return null
	const values = list.getElements().map((element) => stringOf(element))
	return values.every((value) => value !== null) ? (values as string[]) : null
}

function transitionsOf(node: Node | undefined): Record<string, string[]> | null {
	const object = resolve(node)?.asKind(SyntaxKind.ObjectLiteralExpression)
	if (object === undefined) return null
	const transitions: Record<string, string[]> = {}
	for (const property of object.getProperties()) {
		const key = keyOf(property)
		const targets = stringsOf(property.asKind(SyntaxKind.PropertyAssignment)?.getInitializer())
		if (key !== undefined && targets !== null) transitions[key] = targets
	}
	return transitions
}

function machineOf(node: Node | undefined): StateMachineMeta | null {
	const object = resolve(node)?.asKind(SyntaxKind.ObjectLiteralExpression)
	if (object === undefined) return null
	const keys = new Set(object.getProperties().map(keyOf))
	if (!keys.has("initial") && !keys.has("terminal") && !keys.has("transitions")) return null
	return {
		initial: keys.has("initial") ? stringOf(propertyValue(object, "initial")) : null,
		terminal: keys.has("terminal") ? stringsOf(propertyValue(object, "terminal")) : null,
		transitions: keys.has("transitions") ? transitionsOf(propertyValue(object, "transitions")) : null,
	}
}

/** The identifier `node` is (after wrappers), as the name a generated file would import. */
function referenceOf(node: Node | undefined): string | null {
	const bare = node === undefined ? undefined : unwrap(node)
	return bare?.isKind(SyntaxKind.Identifier) ? bare.getText() : null
}

/** The calls in a column expression, outermost first. */
function calls(column: Node): CallExpression[] {
	const own = column.asKind(SyntaxKind.CallExpression)
	return [...(own === undefined ? [] : [own]), ...column.getDescendantsOfKind(SyntaxKind.CallExpression)]
}

export function callNamed(column: Node, name: string): CallExpression | undefined {
	return calls(column).find((c) => c.getExpression().getText() === name)
}

/** `.$type<(typeof X)[number]>()` names X */
function typedBy(column: Node): Node | undefined {
	const call = calls(column).find(
		(c) => c.getExpression().asKind(SyntaxKind.PropertyAccessExpression)?.getName() === "$type",
	)
	const query = call?.getTypeArguments()[0]?.getFirstDescendantByKind(SyntaxKind.TypeQuery)
	return query?.getExprName()
}

/** The enum `column` declares, or null when it is no enum column. */
export function readEnum(column: Node): EnumSource | null {
	const call = callNamed(column, "c.enum")
	if (call !== undefined) {
		const [, valuesArg, machineArg] = call.getArguments()
		const values = stringsOf(valuesArg)
		return { machine: machineOf(machineArg), reference: values === null ? referenceOf(valuesArg) : null, values }
	}
	const typed = typedBy(column)
	if (typed === undefined) return null
	const values = stringsOf(typed)
	return { machine: null, reference: values === null ? typed.getText() : null, values }
}
