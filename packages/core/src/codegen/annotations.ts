/**
 * A column's constraints, from the record its `c` helper was given: every key one the column
 * types allow, a pattern one comb can emit, and `autogenerate` defaulting to true on a column
 * something other than the caller fills.
 */
import type { ConstantValue, FieldConstraintsMeta } from "./analyzer-types.ts"
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
 * A field's constraints from the record its column helper was given, every key one the column
 * types allow and a pattern one comb can emit; an error at `place` otherwise. `filled` says what
 * fills the column, never its name (F13): comb's own timestamp helpers, or a timestamp's default
 * or update hook; a column named createdAt that nothing fills is the caller's to give
 */
export function fieldConstraintsOf(
	constraints: Readonly<Record<string, ConstantValue>>,
	{ fieldName, filled, place }: { fieldName: string; filled: boolean; place: string },
): FieldConstraints {
	const unknown = Object.keys(constraints).find((key) => !KNOWN.has(key))
	if (unknown !== undefined) throw new Error(`${place}: comb reads no constraint named ${unknown}`)
	if (constraints["mutable"] === true && constraints["nomutate"] === true)
		throw new Error(`${place}: mutable and nomutate contradict; declare one`)

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
		private: constraints["private"] === true || fieldName.startsWith("_"),
		tenant: constraints["tenant"] === true,
		trim: constraints["trim"] === true,
		uppercase: constraints["uppercase"] === true,
		url: constraints["url"] === true,
	}
}
