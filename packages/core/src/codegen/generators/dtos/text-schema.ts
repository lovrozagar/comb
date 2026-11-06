/** The Zod expression of a text column: its kind, transforms and bounds, by schema type. */
import type { FieldConstraints } from "../../annotations.ts"
import type { FieldMeta } from "../../analyzer-types.ts"
import { type Base, type Build, plain } from "./build-types.ts"
import { STORABLE_TEXT_RULE } from "../../../storable-text.ts"
import { isMutative } from "./schema-type.ts"
import { regexExpression } from "../../utils/pattern.ts"

/* the text guard every written text takes: comb's own isStorableText, which the shared file imports, as a
   refine sits in the structural core the shared schemas share there */
const TEXT_GUARD = `.refine(comb.isStorableText, { message: "Must not contain U+0000 or an unpaired surrogate" })`

/* the key that says what TEXT_GUARD refuses */
const GUARD_KEY = { "x-comb-text": STORABLE_TEXT_RULE }
/* z.url()'s check, the WHATWG parse, which no standard keyword states (meta-contract §2.1) */
const URL_KEY = { "x-comb-url": "whatwg" }

/** A written text's length bounds as comb holds them, declared and its own together; null where none */
type TextRange = { max: number | null; min: number | null }

/*
 * An id: 1 to 48 characters, none of ECMAScript's blanks (its WhiteSpace and LineTerminator, what
 * \S refuses), each written out, as Go's RE2 reads \S as ASCII alone. The manifest
 * states it with escapes. The chain hands it to RegExp as a string, as Bun parses no regex literal
 * holding U+2028 or U+2029, and publishes it as the characters themselves: a RegExp's source
 * writes those two as \u escapes, which RE2 does not read
 */
const ID_SOURCE = "^[^\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]{1,48}$"
const ID_PATTERN = `/${ID_SOURCE}/u`
/* the published pattern before the guard, so a field's own trailing meta stays the dedup's to strip */
const ID_CHECK = `.regex(new RegExp("${ID_SOURCE}", "u")).meta({ pattern: "${ID_SOURCE}" })${TEXT_GUARD}`
/* the regexes a kind holds a written text to, as the chain writes each: under u, as JSON Schema reads them */
const HTTPS = "/^https:\\/\\//u"
const NAME = "/^[\\p{L}\\p{M}\\p{N}\\p{Zs}\\p{P}]+$/u"
const IMAGE = "/^(?:https:\\/\\/|data:image\\/)/u"

/* the length comb's ids keep to, which a read states: an imported or older id may not */
const ID_LENGTH = { maxLength: 48, minLength: 1 }

/**
 * Whether a column takes the id rules: a key and a reference to one, never a column by its name,
 * and a c.ref that names no target, as one to another database's key, when it declares no
 * bounds of its own; a reference to a natural key, a c.ref included, takes its own text rules
 */
function isIdText(annotations: FieldConstraints, field: FieldMeta): boolean {
	const untargetedRef = field.combKind === "ref" && field.foreignKey === null
	const declares = field.length !== null || annotations.min !== null || annotations.max !== null
	return (field.combKind === "id" || field.foreignKey?.toId === true || untargetedRef) && !declares
}

/* the shortest value each format admits, measured from its check in a test: an address
   such as a@b.cc, and https:// with one character after it, or alone as an imageUri's prefix */
export const TEXT_FLOORS: { email: number; imageUri: number; url: number } = { email: 6, imageUri: 8, url: 9 }

/** The shortest value `annotations`' format admits; 0 for a text of no format */
const floorOf = ({ email, imageUri, url }: FieldConstraints): number =>
	url ? TEXT_FLOORS.url : email ? TEXT_FLOORS.email : imageUri ? TEXT_FLOORS.imageUri : 0

/**
 * A written text's effective range, the one every emitter reads: an id's 1 to 48; any
 * other text's declared bounds, the column's length its max, its min at least its format's floor,
 * and 1 when it is required and of no format. A password column is such a text: it
 * stores the hash, whatever its scheme's length
 */
function textRange(annotations: FieldConstraints, field: FieldMeta): TextRange {
	if (isIdText(annotations, field)) return { max: ID_LENGTH.maxLength, min: ID_LENGTH.minLength }
	const max = annotations.max ?? field.length
	const floor = floorOf(annotations)
	if (floor > 0) return { max, min: Math.max(annotations.min ?? 0, floor) }
	return { max, min: annotations.min ?? (field.isNotNull ? 1 : null) }
}

/** Refuses a range no value meets: the generated module would throw on import, or refuse every write */
function refuseEmptyRange(field: FieldMeta, { max, min }: TextRange): void {
	if (max !== null && min !== null && min > max)
		throw new Error(`${field.name}: its length min ${min} and max ${max} leave no value; widen them`)
}

/** Every transform codegen can emit, each defined in meta-contract §2.1, which a test holds them to */
export const TRANSFORMS = ["lowercase", "strip-tab-newline", "trim", "uppercase"] as const

/** A rewrite a written text takes before its checks, by its published name */
type Transform = (typeof TRANSFORMS)[number]

const CHAIN: Record<Transform, string> = {
	lowercase: ".toLowerCase()",
	"strip-tab-newline": '.overwrite((value) => value.replace(/[\\t\\n\\r]/g, ""))',
	trim: ".trim()",
	uppercase: ".toUpperCase()",
}

/**
 * A written text's transforms, in the order the chain applies them: an email's and a url's are
 * comb's own normalization, the url's the trim and the tab, LF and CR strip z.url() would do
 * unpublished. The
 * manifest projects this list too, so the channels cannot disagree
 */
export function transformsOf(annotations: FieldConstraints, mutative: boolean): Transform[] {
	if (!mutative) return []
	if (annotations.url) return ["trim", "strip-tab-newline"]
	if (annotations.email) return ["trim", "lowercase"]
	const casing: Transform[] = annotations.lowercase ? ["lowercase"] : annotations.uppercase ? ["uppercase"] : []
	return [...(annotations.trim ? (["trim"] as const) : []), ...casing]
}

/** Transforms first (normalize input), then validation (check bounds), so the published bounds bind the rewritten value */
const transforms = (annotations: FieldConstraints, mutative: boolean): string =>
	transformsOf(annotations, mutative)
		.map((transform) => CHAIN[transform])
		.join("")

/** zod publishes no overwrite, so the list is published as `x-comb-transform`, from the one list the chain is written from */
function transformKey(annotations: FieldConstraints, mutative: boolean): Record<string, unknown> {
	const list = transformsOf(annotations, mutative)
	return list.length === 0 ? {} : { "x-comb-transform": list }
}

/** A range's bounds as zod checks */
const rangeChecks = ({ max, min }: TextRange): string =>
	(min === null ? "" : `.min(${min})`) + (max === null ? "" : `.max(${max})`)

/** A written email's bounds and the pattern it declares, checked after the format */
function emailBounds(annotations: FieldConstraints, range: TextRange): string {
	const pattern = annotations.pattern === null ? "" : `.regex(${regexExpression(annotations.pattern)})`
	/* z.email() publishes its pattern, the check, beside format email, whose grammar refuses a@b-.cc
	   the pattern takes: the pattern publishes alone */
	return `${rangeChecks(range)}${pattern}.meta({ format: void 0 })`
}

/**
 * Bounds a read states and never enforces, as `x-comb-*` meta: a read never refuses a stored row,
 * which an older rule, a migration or an import may have stored past them
 */
export const stated = (bounds: Record<string, number | null>): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(bounds)
			.filter(([, bound]) => bound !== null)
			.map(([rule, bound]) => [`x-comb-${rule}`, bound]),
	)

/* the length a Postgres column holds a read text to */
const heldLength = ({ dialect, field }: Build): number | null => (dialect === "postgres" ? field.length : null)

/* a read text's stated bounds: each declared one, a length no column holds it to among them */
function readKeys(build: Build): Record<string, unknown> {
	const { annotations, field } = build
	const max = annotations.max ?? (heldLength(build) === null ? field.length : null)
	return stated({ maxLength: max, minLength: annotations.min })
}

/** The `x-comb-*` keys a text publishes, which finish writes on the property itself */
function textKeys(build: Build): Record<string, unknown> {
	const { annotations, field, schemaType } = build
	const mutative = isMutative(schemaType)
	const transform = transformKey(annotations, mutative)
	if (isIdText(annotations, field)) return mutative ? { ...transform, ...GUARD_KEY } : stated(ID_LENGTH)
	if (!mutative) return readKeys(build)
	if (annotations.email) return transform
	return annotations.url ? { ...transform, ...URL_KEY, ...GUARD_KEY } : { ...transform, ...GUARD_KEY }
}

/** The checks a name or an image URI takes on a write; what is read back is whatever the column holds */
function kindChecks(annotations: FieldConstraints): string {
	const name = annotations.name
		? `.regex(${NAME}, { message: "Must be a name: letters, marks, numbers, spaces and punctuation" })`
		: ""
	/* a regex, not a refine: JSON Schema publishes it as the pattern, so a client sees the rule */
	const image = annotations.imageUri ? `.regex(${IMAGE}, { message: "Must be an HTTPS URL or a data:image/ URI" })` : ""
	return name + image
}

function textBounds(build: Build, range: TextRange): string {
	const { annotations, field, schemaType } = build
	const mutative = isMutative(schemaType)
	/* the id class matches U+0000 and either half of a pair, so a written id takes the text guard after it */
	if (isIdText(annotations, field)) return mutative ? ID_CHECK : ""
	if (!mutative) {
		const held = heldLength(build)
		return held === null ? "" : `.max(${held})`
	}
	if (annotations.email) return emailBounds(annotations, range)
	return rangeChecks(range) + writeChecks(annotations)
}

/**
 * The checks only a written value takes: its pattern, https, a name's characters, an image URI's
 * scheme, and no U+0000 or lone surrogate, which no engine stores as sent: a 400 here, not a
 * 500 or another value there
 */
function writeChecks(annotations: FieldConstraints): string {
	const pattern = annotations.pattern === null ? "" : `.regex(${regexExpression(annotations.pattern)})`
	const https = annotations.url ? `.regex(${HTTPS}, { message: "Must be an HTTPS URL" })` : ""
	/* z.url() checks by the WHATWG parser, which takes https://a/b c that format uri refuses, and zod
	   drops its format once a regex follows: the https pattern publishes, and no format */
	return pattern + https + kindChecks(annotations) + TEXT_GUARD
}

/** A c.text or c.id column, or any other string column: what every builder before it left */
export function textBase(build: Build): Base {
	const { annotations, field, schemaType } = build
	const mutative = isMutative(schemaType)
	/* the rules the manifest states, so the two channels cannot drift */
	const range = textRules(annotations, field)
	if (mutative) refuseEmptyRange(field, range)
	/* an email or a url is normalized first, then validated: z.email() would refuse the padded input,
	 * and z.url() trims it and strips its tabs and newlines unpublished. Checks run in chain order, and unlike a pipe the chain still
	 * publishes the format and bounds */
	if ((annotations.email || annotations.url) && mutative) {
		const format = annotations.email ? "z.email()" : "z.url()"
		return plain(
			`z.string()${transforms(annotations, mutative)}.check(${format})${textBounds(build, range)}`,
			textKeys(build),
		)
	}
	/* a format bounds what is written; what is read back is whatever the column holds: an email or
	 * URL a migration or an older rule stored */
	return plain(`z.string()${transforms(annotations, mutative)}${textBounds(build, range)}`, textKeys(build))
}

/** What a written text is held to: its effective range and each regex it must match, in the chain's order */
export type TextRules = TextRange & { patterns: string[] }

/**
 * A written text's rules as the DTO's chain checks them, which the manifest states: the
 * range textBase enforces, and the kind's regexes beside the declared one, in the order it checks
 * them. An email's own check is its format, which the manifest's textKind names
 */
export function textRules(annotations: FieldConstraints, field: FieldMeta): TextRules {
	const range = textRange(annotations, field)
	const declared = annotations.pattern === null ? [] : [annotations.pattern]
	if (isIdText(annotations, field)) return { ...range, patterns: [ID_PATTERN] }
	const kind = [annotations.url ? HTTPS : null, annotations.name ? NAME : null, annotations.imageUri ? IMAGE : null]
	return { ...range, patterns: [...declared, ...kind.filter((each) => each !== null)] }
}
