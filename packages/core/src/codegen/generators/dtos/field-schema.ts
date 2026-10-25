/** The Zod expression one column gets in each of the read, readPartial, create and update DTOs. */
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { FieldConstraints } from "../../annotations.ts"
import { isGenerated } from "../../entity-meta.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateExampleMeta } from "./example-meta.ts"

type Build = {
	annotations: FieldConstraints
	dialect: "postgres" | "sqlite"
	field: FieldMeta
	imports: ImportsMeta
	schemaType: SchemaType
}

/* Postgres stores c.integer in int4 */
const INT4 = { max: 2147483647, min: -2147483648 }

/** A builder's answer: the Zod base, or `undefined` when the column is not its kind. */
type Built = string | undefined

const isMutative = (schemaType: SchemaType) => schemaType === "create" || schemaType === "update"
const isRead = (schemaType: SchemaType) => schemaType === "read" || schemaType === "readPartial"

/** A c.enum, a pgEnum or an enum text column, its values read at runtime and written out */
function enumBase({ field }: Build): Built {
	return field.enumValues === null ? undefined : `z.enum(${JSON.stringify(field.enumValues)})`
}

/* no engine stores U+0000 or a lone UTF-16 surrogate as sent: jsonb refuses both, Postgres text
 * refuses U+0000 and takes a lone surrogate as U+FFFD (the driver's UTF-8), libsql cuts at U+0000,
 * bun:sqlite reads a lone surrogate back as other text and SQLite's text functions stop at U+0000
 * (F11). With every escaped
 * backslash taken out of its JSON, a \u0000 left is the one, and a \ud800-\udfff escape a lone
 * surrogate, as JSON.stringify writes a pair as it is */
const JSON_NUL_CHECK =
	'.refine((val) => !/\\\\u(?:0000|d[89a-f])/i.test(JSON.stringify(val ?? null).replace(/\\\\\\\\/g, "")), { message: "Must not contain U+0000 or an unpaired surrogate" })'

/* how JSON Schema names the text guard, a refine it cannot publish as a rule (F56) */
const TEXT_RULE = "no U+0000 or unpaired surrogate"

/*
 * the text guard every written text takes: under u, a lone surrogate is a code point of the range, a
 * pair one code point past it (F11). A refine, not a regex: published as a pattern, Go's and Rust's
 * engines refuse \\u and a surrogate, and a field's own pattern would move into an allOf (F56)
 */
const TEXT_GUARD = `.refine((val) => /^[^\\u0000\\uD800-\\uDFFF]*$/u.test(val), { message: "Must not contain U+0000 or an unpaired surrogate" }).meta({ "x-comb-text": "${TEXT_RULE}" })`

/*
 * a c.json column is its schema, which the runtime reader found exported; a plain json column any
 * JSON value. A written c.json value is piped from its schema into its refined copy: meta on the
 * copy itself would publish the schema inline beside its $ref, while the pipe publishes a plain $ref,
 * the schema's own description kept, with the refines' rules in x- keys beside it (F26, F63)
 */
function jsonBase({ annotations, field, schemaType }: Build): Built {
	const schema = field.combKind === "json" ? field.jsonSchemaName : field.dataType === "object json" ? "z.json()" : null
	if (schema === null) return undefined
	if (!isMutative(schemaType)) return schema
	const limit = annotations.maxBytes
	const size =
		limit === null
			? ""
			: `.refine((val) => !val || new TextEncoder().encode(JSON.stringify(val)).length <= ${limit}, { message: "JSON exceeds ${limit} bytes when serialized" })`
	const rules = `.meta({ "x-comb-text": ${JSON.stringify(TEXT_RULE)}${limit === null ? "" : `, "x-comb-maxBytes": ${limit}`} })`
	const refined = `${schema}${size}${JSON_NUL_CHECK}`
	/* keep the pipe: zod publishes .meta on a refine of a registered schema inline beside its $ref (F63) */
	return field.combKind === "json" ? `z.pipe(${schema}, ${refined})${rules}` : `${refined}${rules}`
}

// lookup-table: the c helpers whose values are numbers or booleans, which numberBase types
const NUMBER_KINDS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"boolean",
	"createdAt",
	"deletedAt",
	"integer",
	"real",
	"serialId",
	"timestamp",
	"updatedAt",
])

/** Whether a column holds numbers: a comb number helper, or a drizzle column whose data type is one */
const isNumeric = (field: FieldMeta) =>
	field.combKind === null ? field.dataType.startsWith("number") : NUMBER_KINDS.has(field.combKind)

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

/** An email's bounds, and on a write the pattern it declares, checked after the format (F9) */
function emailBounds(annotations: FieldConstraints, field: FieldMeta, mutative: boolean): string {
	const pattern = mutative && annotations.pattern !== null ? `.regex(${annotations.pattern})` : ""
	return (annotations.min === null ? "" : `.min(${annotations.min})`) + maxOf(annotations, field) + pattern
}

/* a required text column takes no empty string on create or update */
function minOf(annotations: FieldConstraints, field: FieldMeta, schemaType: SchemaType): string {
	if (annotations.min !== null) return `.min(${annotations.min})`
	return field.isNotNull && isMutative(schemaType) && !annotations.url ? ".min(1)" : ""
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

function textBounds({ annotations, field, schemaType }: Build): string {
	const mutative = isMutative(schemaType)
	if (annotations.password) return mutative && annotations.pattern !== null ? `.regex(${annotations.pattern})` : ""
	if (annotations.email) return emailBounds(annotations, field, mutative)
	/* a key and a reference to one take the id rules, never a column by its name (F10), and so does a
	 * c.ref that names no target, as one to another database's key; a reference to a natural key, a
	 * c.ref included, takes its own text rules (F9) */
	const untargetedRef = field.combKind === "ref" && field.foreignKey === null
	const isIdField = field.combKind === "id" || field.foreignKey?.toId === true || untargetedRef
	/* an id-like column gets the id bounds only when it declares none of its own */
	const declares = field.length !== null || annotations.min !== null || annotations.max !== null
	/* \S matches U+0000 and either half of a pair, so a written id takes the text guard after it (F48) */
	if (isIdField && !declares) return mutative ? `.regex(/^\\S{1,48}$/)${TEXT_GUARD}` : ".min(1).max(48)"
	const min = minOf(annotations, field, schemaType)
	return min + maxOf(annotations, field) + (mutative ? writeChecks(annotations) : "")
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
function textBase(build: Build): string {
	const { annotations, schemaType } = build
	const mutative = isMutative(schemaType)
	/* an email is normalized first, then validated: z.email() would refuse the padded input. Checks
	 * run in chain order, and unlike a pipe the chain still publishes the email format and bounds */
	if (annotations.email && mutative) return `z.string().trim().toLowerCase().check(z.email())${textBounds(build)}`
	return stringKind(annotations, mutative) + transforms(annotations, mutative) + textBounds(build)
}

/* the integer range each column holds: Postgres's int2 and int4, else a JS number's exact range */
const INT2 = { max: 32767, min: -32768 }
const SAFE = { max: "Number.MAX_SAFE_INTEGER", min: "Number.MIN_SAFE_INTEGER" }

type Range = { max: number | string; min: number | string }

/** The range an integer column holds, by what the dialect stores it in */
function integerRange(field: FieldMeta, dialect: Build["dialect"]): Range {
	if (dialect === "sqlite") return SAFE
	if (field.combKind === "integer" || field.combKind === "serialId" || field.dataType === "number int32") return INT4
	return field.dataType === "number int16" ? INT2 : SAFE
}

/** A declared bound clamped to the column's, which a numeric bound is and a safe-integer name is not */
const clamp = (declared: number | null, bound: number | string, pick: (a: number, b: number) => number) =>
	declared === null ? bound : typeof bound === "number" ? pick(declared, bound) : declared

/** An integer: the declared bounds, clamped to what the column holds, so a value read back can be sent back */
function integerOf(annotations: FieldConstraints, range: Range): string {
	return `z.number().int().min(${clamp(annotations.min, range.min, Math.max)}).max(${clamp(annotations.max, range.max, Math.min)})`
}

function numberBase({ annotations, dialect, field }: Build): Built {
	if (!isNumeric(field)) return field.dataType === "boolean" ? "z.boolean()" : undefined
	const { max, min } = annotations
	const kind = field.combKind
	if (kind === "createdAt" || kind === "updatedAt" || kind === "deletedAt") return "timestampSchema"
	if (kind === "boolean") return "z.boolean()"
	/* a date before 1970 is a negative epoch, which both engines store (F11) */
	if (kind === "timestamp") return integerOf(annotations, SAFE)
	const integer = kind === null ? field.dataType.startsWith("number int") : kind === "integer" || kind === "serialId"
	if (integer) return integerOf(annotations, integerRange(field, dialect))
	return `z.number()${min === null ? "" : `.min(${min})`}${max === null ? "" : `.max(${max})`}`
}

const BUILDERS = [enumBase, jsonBase, numberBase]

/* SQLite fills an INTEGER PRIMARY KEY, the rowid's alias, when a create body leaves it out */
const isRowid = (field: FieldMeta, dialect: Build["dialect"]) =>
	dialect === "sqlite" &&
	field.isPrimaryKey &&
	(field.combKind === "integer" || (field.combKind === null && field.columnType === "SQLiteInteger"))

/* by what fills the column, never by its name: a natural key named id is the caller's to give (F6) */
function optionalOnCreate(field: FieldMeta, required: boolean, dialect: Build["dialect"]): boolean {
	if (!required) return true
	return field.constraints.autogenerate || field.hasDefault || field.identity || isRowid(field, dialect)
}

/** `base` with its OpenAPI example, nullability and the schema type's optionality. */
function finish({ dialect, field, schemaType }: Build, base: string): string {
	const example = generateExampleMeta(field)
	/* a composite key's column is required as a single key is (F7) */
	const required = field.isPrimaryKey || field.isNotNull || field.inCompositeKey
	const zodType = `${base}${example?.code ?? ""}${required ? "" : ".nullable()"}`
	if (schemaType === "read") return zodType
	if (schemaType === "create" && !optionalOnCreate(field, required, dialect)) return zodType
	return `${zodType}.optional()`
}

/**
 * The Zod expression for `field` in a `schemaType` DTO, or null when the column has no place in
 * it: a private column is never read back, a reference is never updated, and what comb or the
 * database generates is never written.
 */
export function generateFieldSchema(
	field: FieldMeta,
	schemaType: SchemaType,
	{ dialect = "sqlite", imports }: { dialect?: "postgres" | "sqlite" | undefined; imports: ImportsMeta },
): string | null {
	if (field.constraints.private && isRead(schemaType)) return null
	if (isMutative(schemaType) && isGenerated(field)) return null
	const build: Build = { annotations: field.constraints, dialect, field, imports, schemaType }
	for (const builder of BUILDERS) {
		const base = builder(build)
		if (base !== undefined) return finish(build, base)
	}
	return finish(build, textBase(build))
}
