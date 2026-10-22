/**
 * Field constraint types and parser for Drizzle table fields
 *
 * Extracts constraints from type arguments:
 * Example: c.text("name", { min: 5, max: 254, email: true })
 */
import type { ConstantValue, FieldConstraintsMeta } from "./analyzer-types.ts"
import { constraintsOfText } from "./utils/constraint-reader.ts"
import { patternLiteral } from "./utils/pattern.ts"

// lookup-table: the timestamp names a default or update hook marks as filled by the server
const TIMESTAMP_NAMES = /* @__PURE__ */ new Set([
	"createdAt",
	"updatedAt",
	"deletedAt",
	"created_at",
	"updated_at",
	"deleted_at",
])

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
	"mutable",
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
	return fieldConstraintsOf(constraintsOfText(raw), { fieldName, place: raw, raw })
}

/**
 * A field's constraints from the record its column helper declares (constraint-reader.ts), every
 * key one the column types allow and a pattern one comb can emit; an error at `place` otherwise
 */
export function fieldConstraintsOf(
	constraints: Readonly<Record<string, ConstantValue>>,
	{ fieldName, place, raw }: { fieldName?: string | undefined; place: string; raw: string },
): FieldConstraints {
	const unknown = Object.keys(constraints).find((key) => !KNOWN.has(key))
	if (unknown !== undefined) throw new Error(`${place}: comb reads no constraint named ${unknown}`)
	if (constraints["mutable"] === true && constraints["nomutate"] === true)
		throw new Error(`${place}: mutable and nomutate contradict; declare one`)

	/* Check if this is a timestamp field */
	/* what fills the column, never its name (F13): comb's own timestamp helpers, or a timestamp's
	   default or update hook; a column named createdAt that nothing fills is the caller's to give */
	const filled =
		/^\s*c\.(?:createdAt|updatedAt|deletedAt)\s*[<(]/.test(raw) ||
		(TIMESTAMP_NAMES.has(fieldName ?? "") &&
			/\.(?:default|\$defaultFn|\$default|\$onUpdate|\$onUpdateFn)\s*\(/.test(raw))
	const autogenerate = filled ? constraints["autogenerate"] !== false : constraints["autogenerate"] === true

	return {
		autogenerate,
		email: constraints["email"] === true,
		imageUri: constraints["imageUri"] === true,
		lowercase: constraints["lowercase"] === true,
		max: typeof constraints["max"] === "number" ? constraints["max"] : null,
		maxBytes: typeof constraints["maxBytes"] === "number" ? constraints["maxBytes"] : null,
		min: typeof constraints["min"] === "number" ? constraints["min"] : null,
		mutable: constraints["mutable"] === true,
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
