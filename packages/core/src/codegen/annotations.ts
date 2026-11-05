/**
 * A column's constraints, from the record its `c` helper was given: every key one the column
 * types allow, a pattern one comb can emit, and `autogenerate` defaulting to true on a column
 * something other than the caller fills.
 */
import type { CombColumnKind } from "../meta/column.ts"
import type { ConstantValue, FieldConstraintsMeta } from "./analyzer-types.ts"
import { patternLiteral } from "./utils/pattern.ts"

/** Field constraints extracted from type arguments */
export type FieldConstraints = FieldConstraintsMeta

/* the keys of each constraint type in src/sqlite/constraints.ts, which tests/types/constraint-keys.typetest.ts holds them to */
export const NUMBER_KEYS = [
	"autogenerate",
	"max",
	"min",
	"mutable",
	"nomutate",
	"private",
	"relation",
	"tenant",
] as const
export const JSON_KEYS = ["autogenerate", "maxBytes", "mutable", "nomutate", "private", "relation", "tenant"] as const
export const ENUM_KEYS = ["nomutate", "private", "tenant"] as const
export const TEXT_KEYS = [
	"autogenerate",
	"email",
	"imageUri",
	"lowercase",
	"max",
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
] as const

type Keys = typeof NUMBER_KEYS
type None = readonly []

/** The constraint keys each c helper takes, its constraint type's; a state machine is c.enum's own */
export type ConstraintKeys = {
	readonly boolean: None
	readonly createdAt: Keys
	readonly deletedAt: Keys
	readonly enum: typeof ENUM_KEYS
	readonly id: None
	readonly integer: Keys
	readonly json: typeof JSON_KEYS
	readonly real: Keys
	readonly ref: typeof TEXT_KEYS
	readonly serialId: None
	readonly text: typeof TEXT_KEYS
	readonly timestamp: Keys
	readonly updatedAt: Keys
}

// lookup-table: the constraint keys each c helper takes
export const CONSTRAINT_KEYS: ConstraintKeys = {
	boolean: [],
	createdAt: NUMBER_KEYS,
	deletedAt: NUMBER_KEYS,
	enum: ENUM_KEYS,
	id: [],
	integer: NUMBER_KEYS,
	json: JSON_KEYS,
	real: NUMBER_KEYS,
	ref: TEXT_KEYS,
	serialId: [],
	text: TEXT_KEYS,
	timestamp: NUMBER_KEYS,
	updatedAt: NUMBER_KEYS,
}

/* every key any helper takes, so a key none takes is named as one comb does not read */
const KNOWN: readonly string[] = [...TEXT_KEYS, "maxBytes"]

/** Refuses a key the helper's constraint type does not take, naming the helper: its rule would be dropped without a word */
function refuseForeignKeys(
	constraints: Readonly<Record<string, ConstantValue>>,
	{ helper, place }: { helper: CombColumnKind | null; place: string },
): void {
	if (helper !== null && !Object.hasOwn(CONSTRAINT_KEYS, helper))
		throw new Error(`${place}: comb has no helper c.${helper}`)
	const allowed: readonly string[] = helper === null ? [] : CONSTRAINT_KEYS[helper]
	const key = Object.keys(constraints).find((each) => !allowed.includes(each))
	if (key === undefined) return
	if (!KNOWN.includes(key)) throw new Error(`${place}: comb reads no constraint named ${key}`)
	throw new Error(`${place}: ${helper === null ? "a drizzle column" : `c.${helper}`} takes no ${key}`)
}

/* the keys no field takes together, and why: either would win without a word; a
   tenant column moving on update would move the row to another tenant */
const CONTRADICTIONS: ReadonlyArray<readonly [string, string, string]> = [
	["mutable", "nomutate", "declare one"],
	["lowercase", "uppercase", "declare one"],
	["tenant", "mutable", "a tenant column is set once; a row does not move between tenants"],
]

/* a text's kinds: one rule each, so a second would drop the first's without a word */
const KINDS = ["email", "imageUri", "name", "password", "url"] as const

// lookup-table: the keys a kind would drop without a word, and what it does instead; any other it holds
const DROPPED: Readonly<Record<string, { keys: readonly string[]; said: string; what: string }>> = {
	email: { keys: ["uppercase"], said: "it is lowercased", what: "an email" },
	password: { keys: ["lowercase", "trim", "uppercase"], said: "it is kept as written", what: "a password" },
	url: { keys: ["lowercase", "uppercase"], said: "it is kept as written, but for its trim", what: "a url" },
}

/** Refuses a second kind, or a key the one declared would drop, each of which a reader of the tables file believes holds */
function refuseKinds(constraints: Readonly<Record<string, ConstantValue>>, place: string): void {
	const [kind, second] = KINDS.filter((each) => constraints[each] === true)
	if (second !== undefined) throw new Error(`${place}: ${kind} and ${second} contradict; declare one`)
	const dropped = DROPPED[kind as string]
	const key = dropped?.keys.find((each) => constraints[each] === true)
	if (key !== undefined) throw new Error(`${place}: ${dropped?.what} takes no ${key}: ${dropped?.said}`)
}

/**
 * Refuses declared bounds that hold no value: a min past its max, on any column; a
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
 * otherwise. `filled` says what fills the column, never its name: comb's own timestamp
 * helpers, or a timestamp's default or update hook; a column named createdAt that nothing fills is
 * the caller's to give. `measure` says whether min and max bound a length (text) or a value
 */
/** Refuses what no field can be declared with: an unknown measure or constraint, a contradiction, a bad relation, empty bounds */
function refuseMalformed(
	constraints: Readonly<Record<string, ConstantValue>>,
	{ helper, measure, place }: { helper: CombColumnKind | null; measure: "length" | "value"; place: string },
): void {
	/* a JavaScript caller's measure reaches here unchecked by tsc */
	if (measure !== "length" && measure !== "value") throw new Error(`${place}: measure must be "length" or "value"`)
	refuseForeignKeys(constraints, { helper, place })
	const contradiction = CONTRADICTIONS.find(([a, b]) => constraints[a] === true && constraints[b] === true)
	if (contradiction !== undefined) {
		const [a, b, why] = contradiction
		throw new Error(`${place}: ${a} and ${b} contradict; ${why}`)
	}
	refuseKinds(constraints, place)
	const relation = constraints["relation"]
	/* a relation's name is a property of the generated relations, so it is an identifier */
	if (relation !== undefined && (typeof relation !== "string" || !/^[A-Za-z_$][\w$]*$/.test(relation)))
		throw new Error(`${place}: relation ${JSON.stringify(relation)} is no name a relation can take`)
	refuseEmptyBounds(constraints, { measure, place })
}

/**
 * A column's declared constraints, checked and with comb's defaults applied. Throws on a key the
 * helper does not take, a value of the wrong type, two keys that contradict, or bounds no value
 * meets, each message prefixed with `place`
 */
export function fieldConstraintsOf(
	constraints: Readonly<Record<string, ConstantValue>>,
	{
		fieldName,
		filled,
		helper,
		measure,
		place,
	}: {
		/** the column's property name; one starting with `_` is private */
		fieldName: string
		/** whether something other than the caller fills the column, a `c.createdAt`, `c.updatedAt` or `c.deletedAt` column, or a timestamp key's default or update hook, which turns `autogenerate` on unless it is declared false */
		filled: boolean
		/** the c helper that built the column, whose constraint type names the keys it takes; null for a drizzle column, which takes none */
		helper: CombColumnKind | null
		/** what `min` and `max` bound: a text's length, or the value itself */
		measure: "length" | "value"
		/** where the column is declared, as each error message names it */
		place: string
	},
): FieldConstraints {
	refuseMalformed(constraints, { helper, measure, place })
	const relation = constraints["relation"]

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
