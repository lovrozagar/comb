import { declarationOf, declaredNames, isHiddenMember, walkPublic } from "./public-declarations.js"
import { findPackageRoot, publicSurface } from "./public-surface.js"

/* Hover is the docs a consumer reads: every declaration the package's exports reach, and every member they can see on
 * it, carries a written doc, in the consumer's terms, on a shape this rule can see. */

const ASK = "say what a caller needs and the type does not"
const FAULTS = {
	empty: `its JSDoc is empty: ${ASK}`,
	inferred: "its type is inferred, so its shape goes unchecked: write the type out",
	internal: "its JSDoc cites an internal reference, which ships to consumers: say it in their terms",
	missing: `has no JSDoc: add a /** */ block that ${ASK.replace("say ", "says ")}`,
	restates: `its JSDoc only restates the name: ${ASK}`,
	sameLine: "its JSDoc shares a line with the code before it, so editors do not show it: put it on its own line",
}

// lookup-table: the words a doc may hold beside the name and still say nothing
const STOPWORDS = new Set("a an the of for to this that is are value option options returns type property".split(" "))
/* comb's own references, which mean nothing to a consumer: a review round (r22, r22b), a milestone (M75), a plan (plan
 * 21), a finding (PA1, AD14, PA3n) and a step (B2-3). A finding id is two capitals and at most two digits, so a
 * Postgres version (PG17), RE2, an SQLSTATE (XX000) and a target such as ES2022 or HS256 stay clean. */
const INTERNAL =
	/\br[0-9]{2,}[a-z]?\b|\bM[0-9]{2,3}\b|\b[Pp]lan [0-9]+\b|\b(?!PG|RE)[A-Z]{2}[0-9]{1,2}[a-z]?\b|\bB[0-9]+-[0-9]+\b/

const SIGNATURES = {
	TSCallSignatureDeclaration: "(call)",
	TSConstructSignatureDeclaration: "(new)",
	TSIndexSignature: "(index)",
}
// lookup-table: the member nodes a consumer sees and a doc goes on
const MEMBERS = new Set([
	"AccessorProperty",
	"MethodDefinition",
	"PropertyDefinition",
	"TSAbstractMethodDefinition",
	"TSAbstractPropertyDefinition",
	"TSEnumMember",
	"TSMethodSignature",
	"TSPropertySignature",
])

// lookup-table: the nodes arithmetic on literals is made of
const LITERAL_ARITHMETIC = new Set(["BinaryExpression", "ParenthesizedExpression", "UnaryExpression"])

function isLiteral(node) {
	if (node === null || node === undefined) return false
	if (node.type === "Literal") return true
	if (node.type === "TemplateLiteral") return node.expressions.length === 0
	if (!LITERAL_ARITHMETIC.has(node.type)) return false
	if (node.type === "BinaryExpression") return isLiteral(node.left) && isLiteral(node.right)
	return isLiteral(node.argument ?? node.expression)
}

function statesItsType(init) {
	if (init?.type === "TSSatisfiesExpression") return statesItsType(init.expression)
	if (isLiteral(init) || init?.type === "TSAsExpression") return true
	const isFunction = init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression"
	return isFunction && Boolean(init.returnType)
}

function keyName(key) {
	if (key.type === "Identifier") return key.name
	if (key.type === "Literal") return String(key.value)
	if (key.type === "MemberExpression") return `${key.object.name}.${key.property.name}`
	return key.name ?? "(computed)"
}

function isUnnameableKey(node) {
	return node.computed === true && node.key?.type === "Identifier"
}

function docText(comment) {
	return comment.value
		.replace(/^\*/, "")
		.split("\n")
		.map((line) => line.replace(/^\s*\*?\s?/, ""))
		.join("\n")
}

function words(text) {
	return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

function nameWords(name) {
	return words(name.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2"))
}

function faultIn(comment, name) {
	if (comment === undefined) return "missing"
	const text = docText(comment)
	const prose = text.split(/^\s*@/m)[0].trim()
	if (prose === "") return "empty"
	if (INTERNAL.test(text)) return "internal"
	const own = new Set([...nameWords(name), ...words(name)])
	return words(prose).every((word) => own.has(word) || STOPWORDS.has(word)) ? "restates" : null
}

/* TypeScript attaches a member's doc only from the comments after a line break, so `{ /** x *\/ a: string }` is no doc */
function sharesLine(context, comment) {
	const text = context.sourceCode.getText()
	return text.slice(text.lastIndexOf("\n", comment.start) + 1, comment.start).trim() !== ""
}

function jsdocOf(context, node) {
	const comments = context.sourceCode.getCommentsBefore(node)
	return comments.findLast((comment) => comment.type === "Block" && comment.value.startsWith("*"))
}

/* the walk of one public declaration; `label` is `Owner.member`, `name` the part a doc may not merely restate */
function checker(context, owner, entry) {
	const report = (fault, node, label) =>
		context.report({ message: `\`${label}\` is public through "${entry}" and ${FAULTS[fault]}`, node })
	const check = (node, label, name) => {
		const comment = jsdocOf(context, node)
		const inline = comment !== undefined && node.type !== "TSParameterProperty" && sharesLine(context, comment)
		const fault = inline ? "sameLine" : faultIn(comment, name)
		if (fault !== null) report(fault, node, label)
	}
	const inferred = (node, label) => report("inferred", node, label)
	return { check, inferred, owner }
}

function methodKey(node) {
	return `${node.static ? "static " : ""}${keyName(node.key)}`
}

function isBareClassMember(body, node) {
	if (node.type !== "MethodDefinition") return false
	const siblings = body.filter(
		(other) => other !== node && other.type === node.type && methodKey(other) === methodKey(node),
	)
	if (node.kind === "set") return siblings.some((other) => other.kind === "get")
	const signed = siblings.some((other) => other.value.type === "TSEmptyBodyFunctionExpression")
	return signed && node.value.type !== "TSEmptyBodyFunctionExpression"
}

function checkReturn(walk, node, label) {
	const isFunction = node.type === "MethodDefinition" && node.kind !== "constructor" && node.kind !== "set"
	if (isFunction && node.value.body && !node.value.returnType) walk.inferred(node, label)
}

function checkClassValue(walk, node, label) {
	const isProperty = node.type === "PropertyDefinition" || node.type === "AccessorProperty"
	if (isProperty && !node.typeAnnotation && !statesItsType(node.value)) walk.inferred(node, label)
}

function checkMember(walk, node, siblings) {
	const name = keyName(node.id ?? node.key)
	const label = `${walk.owner}.${name}`
	if (siblings !== undefined && isBareClassMember(siblings, node)) return
	walk.check(node, label, name)
	checkReturn(walk, node, label)
	checkClassValue(walk, node, label)
}

function visitorOf(walk) {
	const visit = (node) => {
		if (node.type === "ClassBody") return classBody(node)
		if (node.type === "TSParameterProperty") return parameterProperty(node)
		if (node.type === "TSConditionalType") return conditional(node)
		if (node.type in SIGNATURES) walk.check(node, `${walk.owner}.${SIGNATURES[node.type]}`, "")
		if (!MEMBERS.has(node.type)) return true
		if (isUnnameableKey(node)) return false
		checkMember(walk, node)
		return true
	}
	const classBody = (body) => {
		for (const member of body.body) {
			/* a static block's statements run once at load and declare nothing a consumer reaches */
			if (member.type === "StaticBlock" || isHiddenMember(member) || isUnnameableKey(member)) continue
			/* an index signature is checked by the visit, as on an interface */
			if (!MEMBERS.has(member.type)) {
				walkPublic(member, visit)
				continue
			}
			checkMember(walk, member, body.body)
			walkPublic(member.type === "MethodDefinition" ? member.value : member, skipSelf(member, visit))
		}
		return false
	}
	const parameterProperty = (node) => {
		walk.check(node, `${walk.owner}.${keyName(node.parameter)}`, keyName(node.parameter))
		return true
	}
	const conditional = (node) => {
		for (const part of [node.checkType, node.trueType, node.falseType]) walkPublic(part, visit)
		return false
	}
	return visit
}

function skipSelf(self, visit) {
	return (node) => (node === self ? true : visit(node))
}

/* `file` is the linted file: its rule context, the public names it declares and the functions it overloads */
function checkDeclaration(file, statement, name) {
	const declaration = declarationOf(statement)
	const walk = checker(file.context, name, file.names.get(name))
	const variable = declaration.declarations?.find((d) => d.id.name === name)
	if (declaration.type === "FunctionDeclaration" && file.signed.has(name)) return
	walk.check(statement, name, name)
	if (variable !== undefined && !variable.id.typeAnnotation && !statesItsType(variable.init))
		walk.inferred(statement, name)
	if (declaration.type === "FunctionDeclaration" && !declaration.returnType) walk.inferred(statement, name)
	walkPublic(variable ?? declaration, visitorOf(walk))
}

function signedNames(program) {
	const signed = new Set()
	for (const statement of program.body) {
		const declaration = declarationOf(statement)
		if (declaration?.type === "TSDeclareFunction") signed.add(declaration.id.name)
	}
	return signed
}

export const rule = {
	create(context) {
		const root = findPackageRoot(context.filename)
		if (root === null) return {}
		const surface = publicSurface(root)
		return {
			Program(program) {
				for (const { file, form } of surface.unknown) {
					if (file !== context.filename) continue
					const message = `comb/public-jsdoc cannot follow ${form} here, so what it exposes goes unchecked: write it as a plain export`
					context.report({ message, node: program })
				}
				const names = surface.names.get(context.filename)
				if (names === undefined) return
				const file = { context, names, signed: signedNames(program) }
				for (const statement of program.body) {
					for (const name of declaredNames(statement)) {
						if (names.has(name)) checkDeclaration(file, statement, name)
					}
				}
			},
		}
	},
}
