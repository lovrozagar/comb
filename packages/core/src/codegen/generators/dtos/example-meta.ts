/**
 * The `.meta({ examples })` a field's schema carries for OpenAPI, preferring the shared `_m.*`
 * objects over inline ones.
 */
import type { FieldMeta } from "../../analyzer-types.ts"

const EXAMPLE_ULID = "01h5a3g8k9m2n4p6q8r0t2v4x6"
const ALPHANUMERIC_CYCLE = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"

/**
 * Shared meta example keys emitted in _shared/index.gen.ts.
 * Entity files reference `_m.string` instead of inline `{ examples: ["string"] }`.
 */
export const SHARED_META_KEYS = [
	"boolean",
	"email",
	"integer",
	"real",
	"serialId",
	"string",
	"timestamp",
	"url",
] as const
type SharedMetaKey = (typeof SHARED_META_KEYS)[number]

export const SHARED_META_VALUES: Record<SharedMetaKey, string> = {
	boolean: "{ examples: [true] }",
	email: `{ examples: ["user@example.com"] }`,
	integer: "{ examples: [42] }",
	real: "{ examples: [0.5] }",
	serialId: "{ examples: [1] }",
	string: `{ examples: ["string"] }`,
	timestamp: "{ examples: [1711468800000] }",
	url: `{ examples: ["https://example.com"] }`,
}

/**
 * Shared complete schemas emitted in _shared/index.gen.ts.
 * Identical schemas reused across all entities (no per-field constraints).
 */
export const SHARED_SCHEMAS = {
	boolean: "z.boolean().meta(_m.boolean)",
	real: "z.number().meta(_m.real)",
} as const

export type ExampleResult = {
	/** Code to append: `.meta(_m.string)` or `.meta({ examples: ["custom"] })` */
	code: string
	/** Shared import needed: "_m" for shared meta, specific schema name, or null */
	needsSharedMeta: boolean
}

const shared = (key: SharedMetaKey): ExampleResult => ({ code: `.meta(_m.${key})`, needsSharedMeta: true })
const inline = (example: string): ExampleResult => ({
	code: `.meta({ examples: [${example}] })`,
	needsSharedMeta: false,
})

// lookup-table: the helpers whose values get no example: a reference, a JSON document, a timestamp comb fills
const NO_EXAMPLE_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"createdAt",
	"deletedAt",
	"json",
	"ref",
	"updatedAt",
])

/* sensitive or structured values get no example: the schema says enough, the value would leak */
function hasNoExample({ combKind, constraints, dataType, dimensions, foreignKey }: FieldMeta): boolean {
	/* a pattern decides what the value looks like, which no generic example can know; an array's
	 * example would be its element's, of the wrong shape (F49) */
	if (constraints.private || constraints.password || constraints.pattern !== null || foreignKey !== null) return true
	if ((dimensions ?? 0) > 0) return true
	if (combKind === null) return dataType === "object json"
	return NO_EXAMPLE_KINDS.has(combKind)
}

/* the shared examples' own values, which a bound may refuse */
const SHARED_NUMBER = { integer: 42, real: 0.5, timestamp: 1_711_468_800_000 }

/**
 * A number its bounds accept: the shared example when it fits, else the midpoint of two bounds,
 * or the one bound it misses
 */
function midpoint(field: FieldMeta, key: keyof typeof SHARED_NUMBER): ExampleResult {
	const { max, min } = field.constraints
	const fits = (value: number) => (min === null || value >= min) && (max === null || value <= max)
	if (fits(SHARED_NUMBER[key])) return shared(key)
	if (min !== null && max !== null)
		return inline(String(key === "real" ? (min + max) / 2 : Math.floor((min + max) / 2)))
	return inline(String(min ?? max))
}

/** `length` characters of the alphanumeric cycle, repeated as far as it takes */
const cycleOf = (length: number) =>
	ALPHANUMERIC_CYCLE.repeat(Math.ceil(length / ALPHANUMERIC_CYCLE.length)).slice(0, length)

/** A text example its length bounds accept: the shared "string" when it fits, else the cycle at the length they allow */
function textExample({ constraints: { max, min } }: FieldMeta): ExampleResult {
	const word = "string".length
	if ((min === null || min <= word) && (max === null || max >= word)) return shared("string")
	return inline(JSON.stringify(cycleOf(max !== null && max < word ? max : (min as number))))
}

/** A rule's answer: an example, `null` for none at all, `undefined` when the field is not its kind */
type Rule = (field: FieldMeta) => ExampleResult | null | undefined

/* each text kind's example, which its own check accepts: an image URI is an HTTPS URL to an image */
const KIND_EXAMPLES = { email: "user@example.com", imageUri: "https://example.com/a.png", url: "https://example.com" }

/** The example of a text kind, or none when the column is shorter than it (F31) or needs more (F30) */
function kindExample(field: FieldMeta): ExampleResult | null | undefined {
	const { constraints } = field
	const kind = constraints.email ? "email" : constraints.url ? "url" : constraints.imageUri ? "imageUri" : undefined
	if (kind === undefined) return undefined
	const max = constraints.max ?? field.length
	const length = KIND_EXAMPLES[kind].length
	if ((max !== null && max < length) || (constraints.min !== null && constraints.min > length)) return null
	return kind === "imageUri" ? inline(JSON.stringify(KIND_EXAMPLES.imageUri)) : shared(kind)
}

const RULES: Rule[] = [
	kindExample,
	/* an id with a prefix is unique per table */
	({ combKind, prefix }) => (combKind === "id" ? inline(`"${prefix ?? "id"}_${EXAMPLE_ULID}"`) : undefined),
	({ combKind }) =>
		combKind === "serialId" ? shared("serialId") : combKind === "boolean" ? shared("boolean") : undefined,
	({ enumValues }) =>
		enumValues !== null && enumValues.length > 0 ? inline(JSON.stringify(enumValues[0])) : undefined,
	(field) =>
		field.combKind === "integer" || field.combKind === "real" || field.combKind === "timestamp"
			? midpoint(field, field.combKind)
			: undefined,
	(field) =>
		field.combKind === "text" || field.combKind === "id" || field.combKind === "enum" ? textExample(field) : undefined,
]

/**
 * The `.meta()` with an OpenAPI example for a field, preferring the shared `_m.*` objects over
 * inline ones; null when the field gets none.
 */
export function generateExampleMeta(field: FieldMeta): ExampleResult | null {
	if (hasNoExample(field)) return null
	for (const rule of RULES) {
		const result = rule(field)
		if (result !== undefined) return result
	}
	return null
}
