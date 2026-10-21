/**
 * Case conversion, and the escapers every generator writes a name it read from the schema through
 */

/** Convert snake_case to camelCase */
export function snakeToCamel(str: string): string {
	return str.replace(/_([a-z])/g, (_, char) => char.toUpperCase())
}

/** Convert snake_case to PascalCase */
export function snakeToPascal(str: string): string {
	const camel = snakeToCamel(str)
	return camel.charAt(0).toUpperCase() + camel.slice(1)
}

/** Convert camelCase to kebab-case */
export function camelToKebab(str: string): string {
	return str.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()
}

/** Convert snake_case/camelCase to SCREAMING_SNAKE_CASE */
export function toScreamingSnakeCase(str: string): string {
	return str.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** A key as an object property: bare when it is an identifier, quoted otherwise */
export const propertyName = (key: string): string => (IDENTIFIER.test(key) ? key : JSON.stringify(key))

/** `object`'s `key` as an expression: `object.key` for an identifier, `object["key"]` otherwise */
export const propertyAccess = (object: string, key: string): string =>
	IDENTIFIER.test(key) ? `${object}.${key}` : `${object}[${JSON.stringify(key)}]`

/**
 * A name read from the schema as a TypeScript string literal. Every generator writes a SQL name,
 * an id prefix or an error key through this, never between hand-written quotes: a name may hold
 * a quote or a backslash.
 */
export const stringLiteral = (text: string): string => JSON.stringify(text)

/** A name as text inside a generated block comment, which a `*\/` in it would close */
export const commentText = (text: string): string => text.replaceAll("*/", "* /")

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A name in generated SQL text: bare when it is a plain identifier, double-quoted otherwise */
export const sqlIdentifier = (name: string): string =>
	SQL_IDENTIFIER.test(name) ? name : `"${name.replaceAll('"', '""')}"`
