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
	"relation",
	"tenant",
	"trim",
	"uppercase",
	"url",
])

/**
 * Refuses declared bounds that hold no value (C1, C4 of r17): a min past its max, on any column; a
 * length bound, `measure` "length" (a text column's), that is no whole number from 0; a maxBytes
 * that is no whole number from 1. Each would publish a schema no value passes, or one zod cannot
 * build, so the generated module would throw on import
 */
function refuseEmptyBounds(
	constraints: Readonly<Record<string, ConstantValue>>,
	{ measure, place }: { measure: "length" | "value"; place: string },
): void {
	const { max, maxBytes, min } = constraints
	const bounds = [
		["min", min],
		["max", max],
	] as const
	if (measure === "length")
		for (const [key, value] of bounds)
			if (typeof value === "number" && !(Number.isInteger(value) && value >= 0))
				throw new Error(`${place}: ${key} ${value} is no length: a length is a whole number from 0`)
	if (typeof min === "number" && typeof max === "number" && min > max)
		throw new Error(`${place}: min ${min} is past max ${max}: no value is both`)
	if (typeof maxBytes === "number" && !(Number.isInteger(maxBytes) && maxBytes >= 1))
		throw new Error(`${place}: maxBytes ${maxBytes} is no size: it is a whole number from 1`)
}

/**
 * A field's constraints from the record its column helper was given, every key one the column
 * types allow, a pattern one comb can emit and bounds that hold a value; an error at `place`
 * otherwise. `filled` says what fills the column, never its name (F13): comb's own timestamp
 * helpers, or a timestamp's default or update hook; a column named createdAt that nothing fills is
 * the caller's to give. `measure` says whether min and max bound a length (text) or a value
 */
export function fieldConstraintsOf(
	constraints: Readonly<Record<string, ConstantValue>>,
	{
		fieldName,
		filled,
		measure,
		place,
	}: { fieldName: string; filled: boolean; measure: "length" | "value"; place: string },
): FieldConstraints {
	const unknown = Object.keys(constraints).find((key) => !KNOWN.has(key))
	if (unknown !== undefined) throw new Error(`${place}: comb reads no constraint named ${unknown}`)
	if (constraints["mutable"] === true && constraints["nomutate"] === true)
		throw new Error(`${place}: mutable and nomutate contradict; declare one`)
	const relation = constraints["relation"]
	/* a relation's name is a property of the generated relations, so it is an identifier (F57) */
	if (relation !== undefined && (typeof relation !== "string" || !/^[A-Za-z_$][\w$]*$/.test(relation)))
		throw new Error(`${place}: relation ${JSON.stringify(relation)} is no name a relation can take`)
	refuseEmptyBounds(constraints, { measure, place })

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
		relation: typeof relation === "string" ? relation : null,
		tenant: constraints["tenant"] === true,
		trim: constraints["trim"] === true,
		uppercase: constraints["uppercase"] === true,
		url: constraints["url"] === true,
	}
}
