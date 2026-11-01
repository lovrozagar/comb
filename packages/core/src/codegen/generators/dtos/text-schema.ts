/** The Zod expression of a text column: its kind, transforms and bounds, by schema type. */
import type { FieldConstraints } from "../../annotations.ts"
import type { FieldMeta } from "../../analyzer-types.ts"
import type { Build } from "./build-types.ts"
import { STORABLE_TEXT_RULE } from "../../../storable-text.ts"
import { isMutative } from "./schema-type.ts"

/* the text guard every written text takes: comb's own isStorableText, which the shared file imports (G1), as a
   refine sits in the structural core F59 shares there */
const TEXT_GUARD = `.refine(comb.isStorableText, { message: "Must not contain U+0000 or an unpaired surrogate" }).meta({ "x-comb-text": "${STORABLE_TEXT_RULE}" })`

/** A written text's length bounds as comb holds them, declared and its own together; null where none */
type TextRange = { max: number | null; min: number | null }

/* the length comb's ids keep to, which a read states: an imported or older id may not (F65) */
const ID_LENGTH = { maxLength: 48, minLength: 1 }

/**
 * Whether a column takes the id rules: a key and a reference to one, never a column by its name
 * (F10), and a c.ref that names no target, as one to another database's key, when it declares no
 * bounds of its own; a reference to a natural key, a c.ref included, takes its own text rules (F9)
 */
function isIdText(annotations: FieldConstraints, field: FieldMeta): boolean {
	const untargetedRef = field.combKind === "ref" && field.foreignKey === null
	const declares = field.length !== null || annotations.min !== null || annotations.max !== null
	return (field.combKind === "id" || field.foreignKey?.toId === true || untargetedRef) && !declares
}

/**
 * A written text's effective range, the one every emitter reads (C1 of r18): a password's own
 * [8, 72] under its declared bounds, bcrypt's 72 bytes the most; an id's 1 to 48; an email's
 * declared bounds; any other text's declared bounds, the column's length its max, and 1 its min
 * when it is required and no url
 */
function textRange(annotations: FieldConstraints, field: FieldMeta): TextRange {
	if (annotations.password) return { max: Math.min(annotations.max ?? 72, 72), min: annotations.min ?? 8 }
	if (isIdText(annotations, field)) return { max: ID_LENGTH.maxLength, min: ID_LENGTH.minLength }
	const max = annotations.max ?? field.length
	if (annotations.email) return { max, min: annotations.min }
	return { max, min: annotations.min ?? (field.isNotNull && !annotations.url ? 1 : null) }
}

/* the shortest value a url's https scheme admits: the scheme and one character */
const URL_FLOOR = "https://".length + 1

/** Refuses a range no value meets, an https URL's floor counted: the generated module would throw on import, or refuse every write */
function refuseEmptyRange(annotations: FieldConstraints, field: FieldMeta, { max, min }: TextRange): void {
	const floor = Math.max(min ?? 0, annotations.url ? URL_FLOOR : 0)
	if (max !== null && floor > max)
		throw new Error(`${field.name}: its length min ${floor} and max ${max} leave no value; widen them`)
}

/* a format bounds what is written; what is read back is whatever the column holds: a password's
 * stored hash, an email or URL a migration or an older rule stored (F12). A written email takes
 * textBase's own normalize-then-check path */
function stringKind(annotations: FieldConstraints, range: TextRange, mutative: boolean): string {
	if (!mutative) return "z.string()"
	/* its own rule, printable ASCII within bcrypt's 72 bytes, under the bounds it declares (F9) */
	if (annotations.password) return `z.string().min(${range.min}).max(${range.max}).regex(/^[\\x20-\\x7E]+$/)`
	return annotations.url ? "z.url()" : "z.string()"
}

/* transforms first (normalize input), then validation (check bounds) */
function transforms(annotations: FieldConstraints, mutative: boolean): string {
	if (!mutative || annotations.password || annotations.email || annotations.url) return ""
	const trim = annotations.trim ? ".trim()" : ""
	const casing = annotations.lowercase ? ".toLowerCase()" : annotations.uppercase ? ".toUpperCase()" : ""
	return trim + casing
}

/** A range's bounds as zod checks */
const rangeChecks = ({ max, min }: TextRange): string =>
	(min === null ? "" : `.min(${min})`) + (max === null ? "" : `.max(${max})`)

/** A written email's bounds and the pattern it declares, checked after the format (F9) */
function emailBounds(annotations: FieldConstraints, range: TextRange): string {
	const pattern = annotations.pattern === null ? "" : `.regex(${annotations.pattern})`
	return rangeChecks(range) + pattern
}

/**
 * Bounds a read states and never enforces, as `x-comb-*` meta: a read never refuses a stored row,
 * which an older rule, a migration or an import may have stored past them (F65)
 */
export function stated(bounds: Record<string, number | null>): string {
	const entries = Object.entries(bounds).filter(([, bound]) => bound !== null)
	if (entries.length === 0) return ""
	return `.meta(${JSON.stringify(Object.fromEntries(entries.map(([rule, bound]) => [`x-comb-${rule}`, bound])))})`
}

/* a read text's bounds: a Postgres length the column holds it to, else each declared one stated (F65) */
function readBounds({ annotations, dialect, field }: Build): string {
	const held = dialect === "postgres" ? field.length : null
	const max = annotations.max ?? (held === null ? field.length : null)
	return (held === null ? "" : `.max(${held})`) + stated({ maxLength: max, minLength: annotations.min })
}

/** The checks a name or an image URI takes on a write; what is read back is whatever the column holds */
function kindChecks(annotations: FieldConstraints): string {
	const name = annotations.name
		? '.regex(/^[\\p{L}\\p{M}\\p{N}\\p{Zs}\\p{P}]+$/u, { message: "Must be a name: letters, marks, numbers, spaces and punctuation" })'
		: ""
	/* a regex, not a refine: JSON Schema publishes it as the pattern, so a client sees the rule */
	const image = annotations.imageUri
		? '.regex(/^(?:https:\\/\\/|data:image\\/)/, { message: "Must be an HTTPS URL or a data:image/ URI" })'
		: ""
	return name + image
}

function textBounds(build: Build, range: TextRange): string {
	const { annotations, field, schemaType } = build
	const mutative = isMutative(schemaType)
	if (annotations.password) return mutative && annotations.pattern !== null ? `.regex(${annotations.pattern})` : ""
	/* \S matches U+0000 and either half of a pair, so a written id takes the text guard after it (F48) */
	if (isIdText(annotations, field)) return mutative ? `.regex(/^\\S{1,48}$/)${TEXT_GUARD}` : stated(ID_LENGTH)
	if (!mutative) return readBounds(build)
	if (annotations.email) return emailBounds(annotations, range)
	return rangeChecks(range) + writeChecks(annotations)
}

/**
 * The checks only a written value takes: its pattern, https, a name's characters, an image URI's
 * scheme, and no U+0000 or lone surrogate, which no engine stores as sent (F11): a 400 here, not a
 * 500 or another value there
 */
function writeChecks(annotations: FieldConstraints): string {
	const pattern = annotations.pattern === null ? "" : `.regex(${annotations.pattern})`
	const https = annotations.url ? `.regex(/^https:\\/\\//, { message: "Must be an HTTPS URL" })` : ""
	/* zod drops a url's format once a regex follows it; published again, a client refuses what z.url() does (F25) */
	const format = annotations.url ? '.meta({ format: "uri" })' : ""
	return pattern + https + kindChecks(annotations) + TEXT_GUARD + format
}

/** A c.text or c.id column, or any other string column: what every builder before it left */
export function textBase(build: Build): string {
	const { annotations, field, schemaType } = build
	const mutative = isMutative(schemaType)
	const range = textRange(annotations, field)
	if (mutative) refuseEmptyRange(annotations, field, range)
	/* an email is normalized first, then validated: z.email() would refuse the padded input. Checks
	 * run in chain order, and unlike a pipe the chain still publishes the email format and bounds */
	if (annotations.email && mutative)
		return `z.string().trim().toLowerCase().check(z.email())${textBounds(build, range)}`
	return stringKind(annotations, range, mutative) + transforms(annotations, mutative) + textBounds(build, range)
}
