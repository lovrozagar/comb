/** The Zod expression one column gets in each of the read, readPartial, create and update DTOs. */
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { FieldConstraints } from "../../annotations.ts"
import { writesOf } from "../../entity-meta.ts"
import { arrayBase } from "./array-schema.ts"
import { type Base, type Build, keyed, metaOf, plain } from "./build-types.ts"
import type { SchemaType, SharedName } from "./dto-types.ts"
import { generateExampleMeta } from "./example-meta.ts"
import { CIDR, pgWriteRule } from "./pg-types.ts"
import { sqliteWriteRule } from "./sqlite-types.ts"
import { isMutative, isRead } from "./schema-type.ts"
import { STORABLE_TEXT_RULE } from "../../../storable-text.ts"
import {
	boundCode,
	clamp,
	integerRange,
	isInteger,
	isNumeric,
	numberRules,
	refuseNoInteger,
	type Range,
	SAFE,
} from "./number-range.ts"
import { stated, textBase, textRules } from "./text-schema.ts"

/** A builder's answer: its base, or `undefined` when the column is not its kind */
type Built = Base | undefined

/**
 * A c.enum, a pgEnum or an enum text column, its values read at runtime and written out; a state
 * column's create takes its machine's `initial` alone, the value a row starts at
 */
function enumBase({ element, field, schemaType }: Build): Built {
	if (field.enumValues === null) return undefined
	const initial = field.states?.initial ?? null
	if (schemaType === "create" && initial !== null && element !== true)
		return plain(`z.literal(${JSON.stringify(initial)})`)
	return plain(`z.enum(${JSON.stringify(field.enumValues)})`)
}

/* no engine stores U+0000 or a lone UTF-16 surrogate as sent: jsonb refuses both, Postgres text
 * refuses U+0000 and takes a lone surrogate as U+FFFD (the driver's UTF-8), libsql cuts at U+0000,
 * bun:sqlite reads a lone surrogate back as other text and SQLite's text functions stop at U+0000.
 * With every escaped
 * backslash taken out of its JSON, a \u0000 left is the one, and a \ud800-\udfff escape a lone
 * surrogate, as JSON.stringify writes a pair as it is */
const JSON_NUL_CHECK =
	'.refine((val) => !/\\\\u(?:0000|d[89a-f])/i.test(globalThis.JSON.stringify(val ?? null).replace(/\\\\\\\\/g, "")), { message: "Must not contain U+0000 or an unpaired surrogate" })'

/*
 * a c.json column is its schema, which the runtime reader found exported; a plain json column any
 * JSON value, comb.jsonValue read, and written as the shared schema that holds no null of its top, so null
 * is the column's to take. A written JSON value is its refined schema behind z.lazy: meta
 * on the refined copy itself would publish the schema inline beside its $ref, while the lazy publishes
 * the $ref, or the schema where none is registered, with the refines' rules in x- keys beside it,
 * and no one-member anyOf a spec reader has to flatten, as a union of one did.
 * A lazy, not a pipe from the schema into its copy: a pipe needs the copy's input to be
 * the schema's output, which TypeScript refuses for a schema with a default or a transform
 */
/** Whether a column holds JSON: a c.json column, or a drizzle one whose data type is JSON */
const isJson = (field: FieldMeta): boolean => field.combKind === "json" || field.dataType === "object json"

function jsonBase({ annotations, field, schemaType }: Build): Built {
	const declared = field.combKind === "json"
	if (!isJson(field)) return undefined
	/* comb's JSON value takes null itself, as a NOT NULL jsonb holds 'null'::jsonb, so a nullable one adds no
	   second null; comb's, as a write's is, so a read publishes CombJsonValue too */
	if (!isMutative(schemaType))
		return declared ? plain(field.jsonSchemaName as string) : { ...plain("comb.jsonValue"), takesNull: true }
	const schema = declared ? field.jsonSchemaName : "jsonValueSchema"
	const limit = annotations.maxBytes
	const keys = { "x-comb-text": STORABLE_TEXT_RULE, ...(limit === null ? {} : { "x-comb-maxBytes": limit }) }
	/* keep the lazy: zod publishes .meta on a refine of a registered schema inline beside its $ref;
	   the refine on the lazy, not inside it, where an app's getter-recursive schema converted after
	   another DTO published a positional definition; a nullable column wraps it as every
	   nullable base is, so `.unwrap()` keeps the keys */
	const uses: SharedName[] = declared ? [] : ["jsonValueSchema"]
	return { code: `z.lazy(() => ${schema})${jsonChecks(limit)}`, keys, takesNull: false, uses }
}

/**
 * A written JSON value's rules as one check: zod publishes a registered schema under two refines
 * inline beside its $ref, and under one as the bare $ref. Each rule broken is its own
 * issue, with its own message, as two refines gave
 */
function jsonChecks(limit: number | null): string {
	if (limit === null) return JSON_NUL_CHECK
	return `.superRefine((val, ctx) => { if (new globalThis.TextEncoder().encode(globalThis.JSON.stringify(val ?? null)).length > ${limit}) ctx.addIssue({ code: "custom", message: "JSON exceeds ${limit} bytes when serialized" }); if (/\\\\u(?:0000|d[89a-f])/i.test(globalThis.JSON.stringify(val ?? null).replace(/\\\\\\\\/g, ""))) ctx.addIssue({ code: "custom", message: "Must not contain U+0000 or an unpaired surrogate" }) })`
}

/* a composite key's column is required as a single key is */
const isRequired = (field: FieldMeta): boolean => field.isPrimaryKey || field.isNotNull || field.inCompositeKey

/**
 * An integer: written, the declared bounds clamped to what the column holds; read, what the column
 * holds, the declared bounds stated
 */
function integerOf(annotations: FieldConstraints, range: Range, schemaType: SchemaType): Base {
	if (isRead(schemaType))
		return plain(
			`z.number().int().min(${boundCode(range.min)}).max(${boundCode(range.max)})`,
			stated({ maximum: annotations.max, minimum: annotations.min }),
		)
	return plain(
		`z.number().int().min(${boundCode(clamp(annotations.min, range.min, Math.max))}).max(${boundCode(clamp(annotations.max, range.max, Math.min))})`,
	)
}

/* a stored float may be an infinity, which z.number() refuses, which JSON writes as null, and which D1
   hands back as null: one branch takes all three and publishes { type: "null" }, the value a client
   is sent, typed number | null; NaN, which z.toJSONSchema cannot represent, still fails it;
    a field's number branch repeats the bounds stated on
   it, as a nullable field's non-null member does */
const readFloat = (keys: Record<string, unknown>): string =>
	`z.union([z.number()${metaOf(keys)}, z.literal([globalThis.Infinity, -globalThis.Infinity, null]).meta({ enum: void 0, type: "null" })])`

function numberBase({ annotations, dialect, element, field, schemaType }: Build): Built {
	if (!isNumeric(field)) return field.dataType === "boolean" ? plain("z.boolean()") : undefined
	const { max, min } = annotations
	const kind = field.combKind
	if (kind === "createdAt" || kind === "updatedAt" || kind === "deletedAt")
		return plain("timestampSchema", {}, ["timestampSchema"])
	if (kind === "boolean") return plain("z.boolean()")
	/* a date before 1970 is a negative epoch, which both engines store */
	if (kind === "timestamp") {
		refuseNoInteger(field.name, annotations, SAFE)
		return integerOf(annotations, SAFE, schemaType)
	}
	if (isInteger(field)) {
		const range = integerRange(field, dialect)
		refuseNoInteger(field.name, annotations, range)
		return integerOf(annotations, range, schemaType)
	}
	/* a read float's base takes null already, so a nullable one publishes null once */
	if (isRead(schemaType)) {
		const keys = stated({ maximum: max, minimum: min })
		return { code: readFloat(element === true ? {} : keys), keys, takesNull: true, uses: [] }
	}
	return plain(`z.number()${min === null ? "" : `.min(${min})`}${max === null ? "" : `.max(${max})`}`)
}

/**
 * A plain column's write rule by its data type, Postgres's or SQLite's; a read
 * keeps the plain type. A cidr's host-bit rule is its keys, so finish puts it beside a
 * nullable field's anyOf and elementOf on items, as §2.1 places every key
 */
function plainTypeBase({ dialect, field, schemaType }: Build): Built {
	const rule =
		field.combKind === null && isMutative(schemaType)
			? (dialect === "postgres" ? pgWriteRule : sqliteWriteRule)(field)
			: undefined
	return rule === undefined
		? undefined
		: rule === CIDR
			? plain(rule, { "x-comb-cidr": true }, ["cidrSchema"])
			: plain(rule)
}

const BUILDERS = [enumBase, jsonBase, plainTypeBase, numberBase]

/* SQLite fills an INTEGER PRIMARY KEY, the rowid's alias, when a create body leaves it out */
const isRowid = (field: FieldMeta, dialect: Build["dialect"]) =>
	dialect === "sqlite" &&
	field.isPrimaryKey &&
	(field.combKind === "integer" || (field.combKind === null && field.columnType === "SQLiteInteger"))

/* by what fills the column, never by its name: a natural key named id is the caller's to give */
function optionalOnCreate(field: FieldMeta, required: boolean, dialect: Build["dialect"]): boolean {
	if (!required) return true
	return field.constraints.autogenerate || field.hasDefault || field.identity || isRowid(field, dialect)
}

/** `base` with its OpenAPI example, nullability unless the base takes null itself, its keys, and the schema type's optionality. */
function finish(build: Build, base: Base): string {
	const { dialect, field, schemaType } = build
	const example = generateExampleMeta(field)
	const required = isRequired(field)
	const zodType = keyed(`${base.code}${example?.code ?? ""}`, base, required || base.takesNull)
	if (schemaType === "read") return zodType
	if (schemaType === "create" && !optionalOnCreate(field, required, dialect)) return zodType
	return `${zodType}.optional()`
}

type FieldSchemaOptions = { dialect?: "postgres" | "sqlite" | undefined; imports: ImportsMeta }

/**
 * The Zod expression for `field` in a `schemaType` DTO and the shared schemas it names, or null
 * when the column has no place in it: a private column is never read back, a reference is never
 * updated, and what comb or the database generates is never written.
 */
export function fieldSchemaOf(
	field: FieldMeta,
	schemaType: SchemaType,
	{ dialect = "sqlite", imports }: FieldSchemaOptions,
): { code: string; uses: readonly SharedName[] } | null {
	if (field.constraints.private && isRead(schemaType)) return null
	if ((schemaType === "create" || schemaType === "update") && !writesOf(field)[schemaType]) return null
	const build: Build = { annotations: field.constraints, dialect, field, imports, schemaType }
	const dimensions = field.dimensions ?? 0
	if (dimensions === 0) {
		const base = baseOf(build)
		return { code: finish(build, base), uses: base.uses }
	}
	/* an array's element is built as a nullable column of one value, as Postgres stores it, so it
	   takes no rule of a NOT NULL column's: no write base takes null itself, and arrayBase adds it where
	   the column's drizzle type declares it, on a read always */
	const one: Build = { ...build, element: true, field: { ...field, dimensions: 0, isNotNull: false } }
	const element = baseOf(one)
	const shape = { dimensions, nullable: !isMutative(schemaType) || field.nullElements === true, schemaType }
	return { code: finish(build, arrayBase(element, shape)), uses: element.uses }
}

/** The Zod expression for `field` in a `schemaType` DTO, as fieldSchemaOf gives it, or null */
export const generateFieldSchema = (
	field: FieldMeta,
	schemaType: SchemaType,
	options: FieldSchemaOptions,
): string | null => fieldSchemaOf(field, schemaType, options)?.code ?? null

/** The Zod base of a column of one value: the first builder's that takes it, else text */
function baseOf(build: Build): Base {
	for (const builder of BUILDERS) {
		const base = builder(build)
		if (base !== undefined) return base
	}
	return textBase(build)
}

/** What a written value of a column is held to: its bounds and the regexes it must match */
export type WriteRules = { max: number | null; maxBytes: number | null; min: number | null; patterns: string[] }

/* a column the builder that takes it bounds by no number and no regex */
const UNBOUNDED: WriteRules = { max: null, maxBytes: null, min: null, patterns: [] }

/**
 * What a written value of `field` is held to, as the manifest states it: the rules of
 * the builder baseOf picks for it, in its order, an array's for each element, as the DTO builds one.
 * A plain Postgres column's type rule is its type's, which the manifest's `kind` names, so
 * none here: an inet's union of formats or a numeric's exclusive bounds fit no min, max or pattern
 */
export function writeRules(field: FieldMeta, dialect: Build["dialect"]): WriteRules {
	const one = !field.dimensions ? field : { ...field, dimensions: 0, isNotNull: false }
	if (one.enumValues !== null) return UNBOUNDED
	if (isJson(one)) return { ...UNBOUNDED, maxBytes: one.constraints.maxBytes }
	if (dialect === "postgres" && one.combKind === null && pgWriteRule(one) !== undefined) return UNBOUNDED
	if (isNumeric(one)) return { ...UNBOUNDED, ...numberRules(one, dialect) }
	if (one.dataType === "boolean") return UNBOUNDED
	const { max, min, patterns } = textRules(one.constraints, one)
	return { max, maxBytes: null, min, patterns }
}
