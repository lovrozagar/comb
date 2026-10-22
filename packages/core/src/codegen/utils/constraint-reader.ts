/**
 * A column helper's constraint object, read on the AST: `c.text("name", { min: 5, max: NAME_MAX })`
 * or the older `c.text<{ min: 5 }>("name")`. Every value is read at its own node, inline or through
 * a const, by the one reader constant-value.ts holds, so two files that each declare their own
 * `NAME_MAX` keep their own (F1), an inline value means what the same text in a const means (F4),
 * and a number is read as runtime reads it (F3). A property comb cannot read, a spread or a
 * computed value among them, fails codegen at its place rather than leave the DTO without a bound
 * (F2). c.enum's third argument is its state machine, which this reads nothing of.
 */
import { type CallExpression, Node, Project, SyntaxKind } from "ts-morph"

import type { ConstantValue } from "../analyzer-types.ts"
import { readValue } from "./constant-value.ts"
import { placeOf } from "./node-text.ts"

/** The column helper call a field's chain starts from: `c.text(…)` in `c.text(…).notNull()` */
function helperCall(value: Node): CallExpression | undefined {
	let node: Node | undefined = value
	while (node !== undefined) {
		const call = node.asKind(SyntaxKind.CallExpression)
		if (call !== undefined && /^c\.\w+$/.test(call.getExpression().getText())) return call
		const next: Node = call === undefined ? node : call.getExpression()
		node = next.asKind(SyntaxKind.PropertyAccessExpression)?.getExpression()
	}
	return undefined
}

/** `node` without `as`, `satisfies` and parentheses */
function bare(node: Node): Node {
	const inner =
		node.asKind(SyntaxKind.AsExpression) ??
		node.asKind(SyntaxKind.SatisfiesExpression) ??
		node.asKind(SyntaxKind.ParenthesizedExpression)
	return inner === undefined ? node : bare(inner.getExpression())
}

/** A property's name as written: `"max"` and `max` alike */
const keyOf = (name: Node): string => name.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? name.getText()

/** The constraints of an object literal: each plain property read at its value's node */
function fromObject(project: Project, object: Node): Record<string, ConstantValue> {
	const out: Record<string, ConstantValue> = {}
	for (const property of object.asKindOrThrow(SyntaxKind.ObjectLiteralExpression).getProperties()) {
		const assigned = property.asKind(SyntaxKind.PropertyAssignment)
		const shorthand = property.asKind(SyntaxKind.ShorthandPropertyAssignment)
		const computed = assigned?.getNameNode().isKind(SyntaxKind.ComputedPropertyName) === true
		if ((assigned === undefined && shorthand === undefined) || computed) {
			throw new Error(
				`${placeOf(property)}: comb cannot read ${property.getText()}: a constraint object takes plain properties, not a spread, a method or a computed name`,
			)
		}
		/* `{ max }` is `{ max: max }`: the name, read where the object stands */
		const value = assigned?.getInitializerOrThrow() ?? (shorthand?.getNameNode() as Node)
		out[keyOf((assigned ?? shorthand)?.getNameNode() as Node)] = readValue(project, value)
	}
	return out
}

/** The constraints a type argument writes, `c.text<{ max: 5 }>(…)`: each a literal type */
function fromTypeLiteral(literal: Node): Record<string, ConstantValue> {
	const out: Record<string, ConstantValue> = {}
	for (const member of literal.asKindOrThrow(SyntaxKind.TypeLiteral).getMembers()) {
		const signature = member.asKind(SyntaxKind.PropertySignature)
		const type = signature?.getTypeNode()?.asKind(SyntaxKind.LiteralType)?.getLiteral()
		if (signature === undefined || type === undefined)
			throw new Error(`${placeOf(member)}: comb cannot read ${member.getText()}: a constraint type takes literal types`)
		const text = type.getText()
		out[keyOf(signature.getNameNode())] =
			text === "true"
				? true
				: text === "false"
					? false
					: (type.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? Number(text.replaceAll("_", "")))
	}
	return out
}

/** The constraints the column helper at the root of `value` declares; none for c.enum or a call without them */
function constraintsAt(project: Project, value: Node): Record<string, ConstantValue> {
	const call = helperCall(value)
	if (call === undefined || call.getExpression().getText() === "c.enum") return {}
	const object = call
		.getArguments()
		.map(bare)
		.find((arg) => arg.isKind(SyntaxKind.ObjectLiteralExpression))
	if (object !== undefined) return fromObject(project, object)
	const typed = call.getTypeArguments()[0]
	return typed?.isKind(SyntaxKind.TypeLiteral) === true ? fromTypeLiteral(typed) : {}
}

/** The constraints a field's source text declares, read by the same reader: names it imports cannot resolve */
function constraintsOfText(raw: string): Record<string, ConstantValue> {
	const project = new Project({ useInMemoryFileSystem: true })
	const file = project.createSourceFile("field.ts", `const field = ${raw}`)
	const initializer = file.getVariableDeclarationOrThrow("field").getInitializerOrThrow()
	return constraintsAt(project, initializer)
}

export { constraintsAt, constraintsOfText, helperCall }
