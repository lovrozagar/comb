/** The Zod expression one column gets in each of the read, readPartial, create and update DTOs. */
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { FieldConstraints } from "../../annotations.ts"
import { isGenerated } from "../../entity-meta.ts"
import type { Build } from "./build-types.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateExampleMeta } from "./example-meta.ts"
import { pgWriteRule } from "./pg-types.ts"
import { isMutative, isRead } from "./schema-type.ts"
import { STORABLE_TEXT_RULE } from "../../../storable-text.ts"
import { stated, textBase } from "./text-schema.ts"

/* Postgres stores c.integer in int4 */
const INT4 = { max: 2147483647, min: -2147483648 }

/** A builder's answer: the Zod base, or `undefined` when the column is not its kind. */
type Built = string | undefined

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

/*
 * a c.json column is its schema, which the runtime reader found exported; a plain json column any
 * JSON value. A written c.json value is its refined schema as the one option of a union: meta on the
 * refined copy itself would publish the schema inline beside its $ref, while the union publishes
 * `anyOf: [$ref]`, the schema's own description kept, with the refines' rules in x- keys beside it
 * (F26, F63). A union, not a pipe from the schema into its copy: a pipe needs the copy's input to be
 * the schema's output, which TypeScript refuses for a schema with a default or a transform
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
	const rules = `.meta({ "x-comb-text": ${JSON.stringify(STORABLE_TEXT_RULE)}${limit === null ? "" : `, "x-comb-maxBytes": ${limit}`} })`
	const refined = `${schema}${size}${JSON_NUL_CHECK}`
	/* keep the union: zod publishes .meta on a refine of a registered schema inline beside its $ref (F63) */
	return field.combKind === "json" ? `z.union([${refined}])${rules}` : `${refined}${rules}`
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

/**
 * An integer: written, the declared bounds clamped to what the column holds; read, what the column
 * holds, the declared bounds stated (F65)
 */
function integerOf(annotations: FieldConstraints, range: Range, schemaType: SchemaType): string {
	if (isRead(schemaType))
		return `z.number().int().min(${range.min}).max(${range.max})${stated({ maximum: annotations.max, minimum: annotations.min })}`
	return `z.number().int().min(${clamp(annotations.min, range.min, Math.max)}).max(${clamp(annotations.max, range.max, Math.min)})`
}

function numberBase({ annotations, dialect, field, schemaType }: Build): Built {
	if (!isNumeric(field)) return field.dataType === "boolean" ? "z.boolean()" : undefined
	const { max, min } = annotations
	const kind = field.combKind
	if (kind === "createdAt" || kind === "updatedAt" || kind === "deletedAt") return "timestampSchema"
	if (kind === "boolean") return "z.boolean()"
	/* a date before 1970 is a negative epoch, which both engines store (F11) */
	if (kind === "timestamp") return integerOf(annotations, SAFE, schemaType)
	const integer = kind === null ? field.dataType.startsWith("number int") : kind === "integer" || kind === "serialId"
	if (integer) return integerOf(annotations, integerRange(field, dialect), schemaType)
	if (isRead(schemaType)) return `z.number()${stated({ maximum: max, minimum: min })}`
	return `z.number()${min === null ? "" : `.min(${min})`}${max === null ? "" : `.max(${max})`}`
}

/** A plain Postgres column's write rule by its data type (F50); a read keeps the plain type (F65) */
const pgTypeBase = ({ dialect, field, schemaType }: Build): Built =>
	dialect === "postgres" && field.combKind === null && isMutative(schemaType) ? pgWriteRule(field) : undefined

const BUILDERS = [enumBase, jsonBase, pgTypeBase, numberBase]

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
	const dimensions = field.dimensions ?? 0
	if (dimensions === 0) return finish(build, baseOf(build))
	/* an array's element is built as a nullable column of one value, as Postgres stores it (F49) */
	const element = baseOf({ ...build, field: { ...field, dimensions: 0, isNotNull: false } })
	return finish(build, arrayOf(dimensions, schemaType, `${element}.nullable()`))
}

/** The Zod base of a column of one value: the first builder's that takes it, else text */
function baseOf(build: Build): string {
	for (const builder of BUILDERS) {
		const base = builder(build)
		if (base !== undefined) return base
	}
	return textBase(build)
}

/* Postgres keeps at most 6 dimensions (MAXDIM) */
const MAX_DIMENSIONS = 6

/* Postgres refuses a ragged multidimensional array: each level's sub-arrays must share one shape */
const RECTANGULAR =
	'.refine((value) => { const shape = (part: unknown): string => (Array.isArray(part) ? `${part.length}[${[...new Set(part.map(shape))].join("|")}]` : ""); return !shape(value).includes("|") }, { message: "Must be a rectangular array: every sub-array of a level the same length" })'

/**
 * An array column of `item`s: written, in exactly its declared dimensions, rectangular past one; read,
 * in any depth Postgres holds, as it keeps no declared dimensions and a read never refuses a stored
 * row (F49)
 */
function arrayOf(dimensions: number, schemaType: SchemaType, item: string): string {
	let nested = `z.array(${item})`
	if (!isMutative(schemaType)) {
		for (let depth = 1; depth < MAX_DIMENSIONS; depth++) nested = `z.array(z.union([${item}, ${nested}]))`
		return nested
	}
	for (let depth = 1; depth < dimensions; depth++) nested = `z.array(${nested})`
	return dimensions > 1 ? `${nested}${RECTANGULAR}` : nested
}
