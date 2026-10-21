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

/* sensitive or structured values get no example: the schema says enough, the value would leak */
function hasNoExample({ constraints, foreignKey, raw }: FieldMeta): boolean {
	/* a pattern decides what the value looks like, which no generic example can know */
	if (constraints.private || constraints.password || constraints.pattern !== null || foreignKey !== null) return true
	if (/\.\$type<\s*z\.infer\b/.test(raw)) return true
	return /c\.(ref|json|createdAt|updatedAt|deletedAt|timestamp)[<(]/.test(raw)
}

/* the shared examples' own values, which a bound may refuse */
const SHARED_NUMBER = { integer: 42, real: 0.5 }

/**
 * A number its bounds accept: the shared example when it fits, else the midpoint of two bounds,
 * or the one bound it misses
 */
function midpoint(field: FieldMeta, key: "integer" | "real"): ExampleResult {
	const { max, min } = field.constraints
	const fits = (value: number) => (min === null || value >= min) && (max === null || value <= max)
	if (fits(SHARED_NUMBER[key])) return shared(key)
	if (min !== null && max !== null)
		return inline(String(key === "integer" ? Math.floor((min + max) / 2) : (min + max) / 2))
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

type Rule = (field: FieldMeta) => ExampleResult | undefined

const RULES: Rule[] = [
	({ constraints }) => (constraints.email ? shared("email") : constraints.url ? shared("url") : undefined),
	/* an id with a prefix is unique per table */
	({ raw }) => {
		if (!/c\.id[<(]/.test(raw)) return undefined
		return inline(`"${/c\.id\(["'](\w+)["']\)/.exec(raw)?.[1] ?? "id"}_${EXAMPLE_ULID}"`)
	},
	({ raw }) =>
		/c\.serialId[<(]/.test(raw) ? shared("serialId") : /c\.boolean[<(]/.test(raw) ? shared("boolean") : undefined,
	({ enumValues }) =>
		enumValues !== null && enumValues.length > 0 ? inline(JSON.stringify(enumValues[0])) : undefined,
	(field) =>
		/c\.integer[<(]/.test(field.raw)
			? midpoint(field, "integer")
			: /c\.real[<(]/.test(field.raw)
				? midpoint(field, "real")
				: undefined,
	(field) => (/c\.(text|id|enum)[<(]/.test(field.raw) ? textExample(field) : undefined),
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
