/**
 * Case conversion utilities
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
