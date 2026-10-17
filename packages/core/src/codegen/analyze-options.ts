/**
 * A table's third argument, `(t) => [...]`: its composite primary key, its unique indexes and its
 * CHECK constraints, read from the AST. A unique index is published as column uniqueness only when
 * it is one: every key a plain column, no `.where()`.
 */
import { type CallExpression, type Node, SyntaxKind } from "ts-morph"
import type { CheckConstraintMeta, UniqueIndexMeta } from "./analyzer-types.ts"

export type TableOptions = {
	checkConstraints: CheckConstraintMeta[]
	hasCompositePrimaryKey: boolean
	uniqueIndexes: UniqueIndexMeta[]
}

/** The calls in one option expression, outermost first: `uniqueIndex("n").on(t.a).where(x)`. */
function chainOf(expression: Node): CallExpression[] {
	const own = expression.asKind(SyntaxKind.CallExpression)
	return [...(own === undefined ? [] : [own]), ...expression.getDescendantsOfKind(SyntaxKind.CallExpression)]
}

/** The call whose callee is the bare identifier `name`, the head of a chain. */
const headCall = (chain: CallExpression[], name: string) =>
	chain.find((call) => call.getExpression().isKind(SyntaxKind.Identifier) && call.getExpression().getText() === name)

/** The call `.method(...)` in a chain. */
const methodCall = (chain: CallExpression[], method: string) =>
	chain.find((call) => call.getExpression().asKind(SyntaxKind.PropertyAccessExpression)?.getName() === method)

function stringArg(call: CallExpression | undefined): string | undefined {
	return call?.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue()
}

/** `t.a, t.b` → [a, b]; null when any key is an expression rather than a column of `param`. */
function plainColumns(on: CallExpression, param: string): string[] | null {
	const columns = on.getArguments().map((arg) => {
		const access = arg.asKind(SyntaxKind.PropertyAccessExpression)
		return access?.getExpression().getText() === param ? access.getName() : null
	})
	return columns.length > 0 && columns.every((c) => c !== null) ? (columns as string[]) : null
}

function uniqueIndexOf(chain: CallExpression[], param: string): UniqueIndexMeta | null {
	const name = stringArg(headCall(chain, "uniqueIndex"))
	const on = methodCall(chain, "on")
	if (name === undefined || on === undefined || methodCall(chain, "where") !== undefined) return null
	const columns = plainColumns(on, param)
	return columns === null ? null : { columns, name }
}

function checkOf(chain: CallExpression[]): CheckConstraintMeta | null {
	const call = headCall(chain, "check")
	const name = stringArg(call)
	const template = call?.getArguments()[1]?.asKind(SyntaxKind.TaggedTemplateExpression)?.getTemplate()
	if (name === undefined || template === undefined) return null
	return { expression: template.getText().slice(1, -1).replace(/\s+/g, " ").trim(), name }
}

/** The option expressions: the elements of the returned array, or the values of an object. */
function optionExpressions(body: Node): Node[] {
	const bare = body.asKind(SyntaxKind.ParenthesizedExpression)?.getExpression() ?? body
	const list = bare.asKind(SyntaxKind.ArrayLiteralExpression)
	if (list !== undefined) return list.getElements()
	const object = bare.asKind(SyntaxKind.ObjectLiteralExpression)
	return (object?.getProperties() ?? []).flatMap((p) => p.asKind(SyntaxKind.PropertyAssignment)?.getInitializer() ?? [])
}

const NO_OPTIONS: TableOptions = { checkConstraints: [], hasCompositePrimaryKey: false, uniqueIndexes: [] }

/** The options a table's third argument declares. */
export function readTableOptions(arg: Node | undefined): TableOptions {
	const arrow = arg?.asKind(SyntaxKind.ArrowFunction)
	if (arrow === undefined) return NO_OPTIONS
	const param = arrow.getParameters()[0]?.getName() ?? "t"
	const options: TableOptions = { checkConstraints: [], hasCompositePrimaryKey: false, uniqueIndexes: [] }
	for (const expression of optionExpressions(arrow.getBody())) {
		const chain = chainOf(expression)
		if (headCall(chain, "primaryKey") !== undefined) options.hasCompositePrimaryKey = true
		const unique = uniqueIndexOf(chain, param)
		if (unique !== null) options.uniqueIndexes.push(unique)
		const check = checkOf(chain)
		if (check !== null) options.checkConstraints.push(check)
	}
	return options
}
