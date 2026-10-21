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

/** A builder's answer: the Zod base, `null` to leave the column out, `undefined` when it is not its kind. */
type Built = string | null | undefined

const isMutative = (schemaType: SchemaType) => schemaType === "create" || schemaType === "update"
const isRead = (schemaType: SchemaType) => schemaType === "read" || schemaType === "readPartial"

/** The named schema in `.$type<z.infer<typeof schema>>()`, recorded as an import; else null. */
function typedSchema(raw: string, jsonSchemaImports: Set<string>): string | null {
	const name = /\.\$type<\s*z\.infer<\s*typeof\s+(\w+)\s*>\s*>/.exec(raw)?.[1]
	if (name === undefined) return null
	jsonSchemaImports.add(name)
	return name
}

function enumBase({ field }: Build): Built {
	if (field.enumValues !== null) return `z.enum(${JSON.stringify(field.enumValues)})`
	if (field.enumName !== null) return `z.enum(${field.enumName})`
	if (field.drizzleHelper !== "enum") return undefined
	throw new Error(`c.enum column "${field.name}": its values are not string literals comb can read: ${field.raw}`)
}

function jsonBase({ annotations, field, schemaType }: Build): Built {
	if (!/c\.json[<(]/.test(field.raw)) return undefined
	if (!field.jsonSchemaName) throw new Error(`c.json() must have schema as second parameter: ${field.raw}`)
	if (annotations.maxBytes === null || !isMutative(schemaType)) return field.jsonSchemaName
	const limit = annotations.maxBytes
	return `${field.jsonSchemaName}.refine((val) => !val || new TextEncoder().encode(JSON.stringify(val)).length <= ${limit}, { message: "JSON exceeds ${limit} bytes when serialized" })`
}

// lookup-table: the column builders whose values are numbers, comb's and drizzle's
const NUMERIC =
	/^\s*(?:c\.)?(?:integer|serialId|serial|bigserial|smallint|bigint|int|real|doublePrecision|numeric)\s*[<(]/

/* a reference is set once, at creation, so it has no place in an update body; a numeric one
 * takes the number rules, the rest the id string */
function foreignKeyBase({ field, schemaType }: Build): Built {
	if (field.foreignKey === null && !/c\.ref[<(]/.test(field.raw)) return undefined
	if (schemaType === "update") return null
	return NUMERIC.test(field.raw) ? undefined : "z.string().min(1).max(48)"
}

/* a password's rules bound what a person types; what is read back is its stored hash */
function stringKind(annotations: FieldConstraints, mutative: boolean): string {
	if (annotations.password) return mutative ? "z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/)" : "z.string()"
	if (annotations.email) return "z.email()"
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

function emailBounds(annotations: FieldConstraints, field: FieldMeta): string {
	return (annotations.min === null ? "" : `.min(${annotations.min})`) + maxOf(annotations, field)
}

/* a required text column takes no empty string on create or update */
function minOf(annotations: FieldConstraints, field: FieldMeta, schemaType: SchemaType): string {
	if (annotations.min !== null) return `.min(${annotations.min})`
	return field.isNotNull && isMutative(schemaType) && !annotations.url ? ".min(1)" : ""
}

/** The checks a name or an image URI takes on a write; what is read back is whatever the column holds */
function kindChecks(annotations: FieldConstraints, mutative: boolean): string {
	if (!mutative) return ""
	const name = annotations.name
		? '.regex(/^[\\p{L}\\p{M}\\p{N}\\p{Zs}\\p{P}]+$/u, { message: "Must be a name: letters, marks, numbers, spaces and punctuation" })'
		: ""
	const image = annotations.imageUri
		? '.refine((v) => /^(?:https:\\/\\/|data:image\\/)/.test(v), { message: "Must be an HTTPS URL or a data:image/ URI" })'
		: ""
	return name + image
}

function textBounds({ annotations, field, schemaType }: Build): string {
	if (annotations.password) return ""
	if (annotations.email) return emailBounds(annotations, field)
	const mutative = isMutative(schemaType)
	const isIdField = field.name === "id" || field.name.endsWith("Id") || field.name.endsWith("_id")
	/* an id-like column gets the id bounds only when it declares none of its own */
	const declares = field.length !== null || annotations.min !== null || annotations.max !== null
	if (isIdField && !declares) return mutative ? ".regex(/^\\S{1,48}$/)" : ".min(1).max(48)"
	const min = minOf(annotations, field, schemaType)
	const pattern = annotations.pattern !== null && mutative ? `.regex(${annotations.pattern})` : ""
	const https =
		annotations.url && mutative ? `.refine((v) => /^https:\\/\\//.test(v), { message: "Must be an HTTPS URL" })` : ""
	return min + maxOf(annotations, field) + pattern + https + kindChecks(annotations, mutative)
}

function textBase(build: Build): Built {
	const { annotations, field, imports, schemaType } = build
	if (!/c\.(text|id)[<(]/.test(field.raw)) return undefined
	const typed = field.raw.includes(".$type<") ? typedSchema(field.raw, imports.jsonSchemaImports) : null
	if (typed !== null) return typed
	const mutative = isMutative(schemaType)
	/* an email is normalized first, then validated: z.email() would refuse the padded input. Checks
	 * run in chain order, and unlike a pipe the chain still publishes the email format and bounds */
	if (annotations.email && mutative) return `z.string().trim().toLowerCase().check(z.email())${textBounds(build)}`
	return stringKind(annotations, mutative) + transforms(annotations, mutative) + textBounds(build)
}

function numberBase({ annotations, dialect, field, schemaType }: Build): Built {
	if (/c\.(createdAt|updatedAt|deletedAt|timestamp)[<(]/.test(field.raw)) return "timestampSchema"
	const { max, min } = annotations
	if (/c\.(integer|serialId)[<(]/.test(field.raw)) {
		/* an unbounded integer written is a non-negative count; one read is whatever the column holds,
		 * and either stays within what the column holds: int4 on Postgres, a JS number's exact range on SQLite */
		const int4 = dialect === "postgres"
		const readFloor = int4 ? `.min(${INT4.min})` : ""
		const floor = min !== null ? `.min(${min})` : isMutative(schemaType) ? ".nonnegative()" : readFloor
		return `z.number().int()${floor}.max(${max ?? (int4 ? INT4.max : "Number.MAX_SAFE_INTEGER")})`
	}
	if (/c\.boolean[<(]/.test(field.raw)) return "z.boolean()"
	if (!/c\.real[<(]/.test(field.raw)) return undefined
	return `z.number()${min === null ? "" : `.min(${min})`}${max === null ? "" : `.max(${max})`}`
}

const BUILDERS = [enumBase, jsonBase, foreignKeyBase, textBase, numberBase]

// lookup-table: the timestamp column names, under either casing
const TIMESTAMP_NAMES = /* @__PURE__ */ new Set([
	"createdAt",
	"updatedAt",
	"deletedAt",
	"created_at",
	"updated_at",
	"deleted_at",
])

/* the database fills a column with a default when a create body leaves it out */
const hasDefault = (raw: string) => /\.(?:default|\$defaultFn|\$default)\s*\(/.test(raw)

function optionalOnCreate(field: FieldMeta, required: boolean): boolean {
	if (!required || field.name === "id" || TIMESTAMP_NAMES.has(field.name)) return true
	return field.constraints.autogenerate || hasDefault(field.raw)
}

/** `base` with its OpenAPI example, nullability and the schema type's optionality. */
function finish(field: FieldMeta, schemaType: SchemaType, base: string): string {
	const example = generateExampleMeta(field)
	const required = field.isPrimaryKey || field.isNotNull
	const zodType = `${base}${example?.code ?? ""}${required ? "" : ".nullable()"}`
	if (schemaType === "read") return zodType
	if (schemaType === "create" && !optionalOnCreate(field, required)) return zodType
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
		if (base === null) return null
		if (base !== undefined) return finish(field, schemaType, base)
	}
	return finish(field, schemaType, "z.unknown()")
}
