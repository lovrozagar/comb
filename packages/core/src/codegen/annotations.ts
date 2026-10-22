/**
 * Field constraint types and parser for Drizzle table fields
 *
 * Extracts constraints from type arguments:
 * Example: c.text("name", { min: 5, max: 254, email: true })
 */
import type { ConstantValue, FieldConstraintsMeta } from "./analyzer-types.ts"
import { constraintsOfText } from "./utils/constraint-reader.ts"
import { patternLiteral } from "./utils/pattern.ts"

/** Field constraints extracted from type arguments */
export type FieldConstraints = FieldConstraintsMeta

// lookup-table: every constraint key the column types allow (src/sqlite/constraints.ts); a state machine is c.enum's own
const KNOWN = /* @__PURE__ */ new Set([
	"autogenerate",
	"email",
	"imageUri",
	"lowercase",
	"max",
	"maxBytes",
	"min",
	"name",
	"nomutate",
	"password",
	"pattern",
	"private",
	"tenant",
	"trim",
	"uppercase",
	"url",
])

/**
 * Parse field constraints from type arguments.
 * Extracts constraints from c.method("name", { ... }) pattern.
 * For timestamp fields (createdAt, updatedAt, deletedAt), autogenerate defaults to true.
 */
export function parseFieldConstraints(raw: string, fieldName?: string): FieldConstraints {
	return fieldConstraintsOf(constraintsOfText(raw), { fieldName, place: raw })
}

/**
 * A field's constraints from the record its column helper declares (constraint-reader.ts), every
 * key one the column types allow and a pattern one comb can emit; an error at `place` otherwise
 */
export function fieldConstraintsOf(
	constraints: Readonly<Record<string, ConstantValue>>,
	{ fieldName, place }: { fieldName?: string | undefined; place: string },
): FieldConstraints {
	const unknown = Object.keys(constraints).find((key) => !KNOWN.has(key))
	if (unknown !== undefined) throw new Error(`${place}: comb reads no constraint named ${unknown}`)

	/* Check if this is a timestamp field */
	const isTimestampField =
		fieldName !== undefined &&
		["createdAt", "updatedAt", "deletedAt", "created_at", "updated_at", "deleted_at"].includes(fieldName)

	/* For timestamp fields, default autogenerate to true unless explicitly set to false */
	const autogenerate = isTimestampField ? constraints["autogenerate"] !== false : constraints["autogenerate"] === true

	return {
		autogenerate,
		email: constraints["email"] === true,
		imageUri: constraints["imageUri"] === true,
		lowercase: constraints["lowercase"] === true,
		max: typeof constraints["max"] === "number" ? constraints["max"] : null,
		maxBytes: typeof constraints["maxBytes"] === "number" ? constraints["maxBytes"] : null,
		min: typeof constraints["min"] === "number" ? constraints["min"] : null,
		name: constraints["name"] === true,
		nomutate: constraints["nomutate"] === true,
		password: constraints["password"] === true,
		pattern: typeof constraints["pattern"] === "string" ? patternLiteral(constraints["pattern"], place) : null,
		private: constraints["private"] === true || fieldName?.startsWith("_") || false,
		tenant: constraints["tenant"] === true,
		trim: constraints["trim"] === true,
		uppercase: constraints["uppercase"] === true,
		url: constraints["url"] === true,
	}
}
