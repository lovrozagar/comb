/**
 * Field constraint types and parser for Drizzle table fields
 *
 * Extracts constraints from type arguments:
 * Example: c.text("name", { min: 5, max: 254, email: true })
 */
import { extractConstraints, type IdentifierValues } from "./utils/constraint-text.ts"

/** Field constraints extracted from type arguments */
export type FieldConstraints = {
	autogenerate: boolean
	email: boolean
	lowercase: boolean
	max: number | null
	maxBytes: number | null
	min: number | null
	nomutate: boolean
	password: boolean
	pattern: string | null
	private: boolean
	tenant: boolean
	trim: boolean
	uppercase: boolean
	url: boolean
}

/**
 * Parse field constraints from type arguments.
 * Extracts constraints from c.method("name", { ... }) pattern.
 * For timestamp fields (createdAt, updatedAt, deletedAt), autogenerate defaults to true.
 */
export function parseFieldConstraints(
	raw: string,
	fieldName?: string,
	identifiers?: IdentifierValues,
): FieldConstraints {
	const constraints = extractConstraints(raw, identifiers)

	/* Check if this is a timestamp field */
	const isTimestampField =
		fieldName !== undefined &&
		["createdAt", "updatedAt", "deletedAt", "created_at", "updated_at", "deleted_at"].includes(fieldName)

	/* For timestamp fields, default autogenerate to true unless explicitly set to false */
	const autogenerate = isTimestampField ? constraints["autogenerate"] !== false : constraints["autogenerate"] === true

	return {
		autogenerate,
		email: constraints["email"] === true,
		lowercase: constraints["lowercase"] === true,
		max: typeof constraints["max"] === "number" ? constraints["max"] : null,
		maxBytes: typeof constraints["maxBytes"] === "number" ? constraints["maxBytes"] : null,
		min: typeof constraints["min"] === "number" ? constraints["min"] : null,
		nomutate: constraints["nomutate"] === true,
		password: constraints["password"] === true,
		pattern: typeof constraints["pattern"] === "string" ? constraints["pattern"] : null,
		private: constraints["private"] === true || fieldName?.startsWith("_") || false,
		tenant: constraints["tenant"] === true,
		trim: constraints["trim"] === true,
		uppercase: constraints["uppercase"] === true,
		url: constraints["url"] === true,
	}
}
