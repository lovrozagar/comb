/** The Zod expression of a text column: its kind, transforms and bounds, by schema type. */
import type { FieldConstraints } from "../../annotations.ts"
import type { FieldMeta } from "../../analyzer-types.ts"
import type { Build } from "./build-types.ts"
import { STORABLE_TEXT_RULE } from "../../../storable-text.ts"
import { isMutative } from "./schema-type.ts"

/* the text guard every written text takes: comb's own isStorableText, which the shared file imports (G1), as a
   refine sits in the structural core F59 shares there */
const TEXT_GUARD = `.refine(comb.isStorableText, { message: "Must not contain U+0000 or an unpaired surrogate" }).meta({ "x-comb-text": "${STORABLE_TEXT_RULE}" })`

/* a format bounds what is written; what is read back is whatever the column holds: a password's
 * stored hash, an email or URL a migration or an older rule stored (F12). A written email takes
 * textBase's own normalize-then-check path */
function stringKind(annotations: FieldConstraints, mutative: boolean): string {
	if (!mutative) return "z.string()"
	/* its own rule, printable ASCII within bcrypt's 72 bytes, under the bounds it declares (F9) */
	if (annotations.password) {
		const min = annotations.min ?? 8
		const max = Math.min(annotations.max ?? 72, 72)
		return `z.string().min(${min}).max(${max}).regex(/^[\\x20-\\x7E]+$/)`
	}
	return annotations.url ? "z.url()" : "z.string()"
}

/* transforms first (normalize input), then validation (check bounds) */
function transforms(annotations: FieldConstraints, mutative: boolean): string {
	if (!mutative || annotations.password || annotations.email || annotations.url) return ""
	const trim = annotations.trim ? ".trim()" : ""
	const casing = annotations.lowercase ? ".toLowerCase()" : annotations.uppercase ? ".toUpperCase()" : ""
	return trim + casing
}

function maxOf(annotations: FieldConstraints, field: FieldMeta): string {
	if (annotations.max !== null) return `.max(${annotations.max})`
	return field.length === null ? "" : `.max(${field.length})`
}

/** A written email's bounds and the pattern it declares, checked after the format (F9) */
function emailBounds(annotations: FieldConstraints, field: FieldMeta): string {
	const pattern = annotations.pattern === null ? "" : `.regex(${annotations.pattern})`
	return (annotations.min === null ? "" : `.min(${annotations.min})`) + maxOf(annotations, field) + pattern
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

/* a required text column takes no empty string on a write */
function minOf(annotations: FieldConstraints, field: FieldMeta): string {
	if (annotations.min !== null) return `.min(${annotations.min})`
	return field.isNotNull && !annotations.url ? ".min(1)" : ""
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

/* the length comb's ids keep to, which a read states: an imported or older id may not (F65) */
const ID_LENGTH = { maxLength: 48, minLength: 1 }

function textBounds(build: Build): string {
	const { annotations, field, schemaType } = build
	const mutative = isMutative(schemaType)
	if (annotations.password) return mutative && annotations.pattern !== null ? `.regex(${annotations.pattern})` : ""
	/* a key and a reference to one take the id rules, never a column by its name (F10), and so does a
	 * c.ref that names no target, as one to another database's key; a reference to a natural key, a
	 * c.ref included, takes its own text rules (F9) */
	const untargetedRef = field.combKind === "ref" && field.foreignKey === null
	const isIdField = field.combKind === "id" || field.foreignKey?.toId === true || untargetedRef
	/* an id-like column gets the id bounds only when it declares none of its own */
	const declares = field.length !== null || annotations.min !== null || annotations.max !== null
	/* \S matches U+0000 and either half of a pair, so a written id takes the text guard after it (F48) */
	if (isIdField && !declares) return mutative ? `.regex(/^\\S{1,48}$/)${TEXT_GUARD}` : stated(ID_LENGTH)
	if (!mutative) return readBounds(build)
	if (annotations.email) return emailBounds(annotations, field)
	return minOf(annotations, field) + maxOf(annotations, field) + writeChecks(annotations)
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
	const { annotations, schemaType } = build
	const mutative = isMutative(schemaType)
	/* an email is normalized first, then validated: z.email() would refuse the padded input. Checks
	 * run in chain order, and unlike a pipe the chain still publishes the email format and bounds */
	if (annotations.email && mutative) return `z.string().trim().toLowerCase().check(z.email())${textBounds(build)}`
	return stringKind(annotations, mutative) + transforms(annotations, mutative) + textBounds(build)
}
