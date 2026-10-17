/** The Zod expression one column gets in each of the read, readPartial, create and update DTOs. */
import type { FieldMeta, ImportsMeta } from "../../analyzer-types.ts"
import type { FieldConstraints } from "../../annotations.ts"
import type { SchemaType } from "./dto-types.ts"
import { generateExampleMeta } from "./example-meta.ts"

type Build = { annotations: FieldConstraints; field: FieldMeta; imports: ImportsMeta; schemaType: SchemaType }

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
	return `${field.jsonSchemaName}.refine((val) => !val || JSON.stringify(val).length <= ${limit}, { message: "JSON exceeds ${limit} characters when serialized" })`
}

/* a reference is set once, at creation, so it has no place in an update body */
function foreignKeyBase({ field, schemaType }: Build): Built {
	if (field.foreignKey === null && !/c\.ref[<(]/.test(field.raw)) return undefined
	return schemaType === "update" ? null : "z.string().min(1).max(48)"
}

function stringKind(annotations: FieldConstraints, mutative: boolean): string {
	if (annotations.password) return "z.string().min(8).max(72).regex(/^[\\x20-\\x7E]+$/)"
	if (annotations.email) return mutative ? "z.email().trim().toLowerCase()" : "z.email()"
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

/* a required text column takes no empty string on create */
function minOf(annotations: FieldConstraints, field: FieldMeta, schemaType: SchemaType): string {
	if (annotations.min !== null) return `.min(${annotations.min})`
	return field.isNotNull && schemaType === "create" && !annotations.url ? ".min(1)" : ""
}

function textBounds({ annotations, field, schemaType }: Build): string {
	if (annotations.password) return ""
	if (annotations.email) return emailBounds(annotations, field)
	const mutative = isMutative(schemaType)
	const isIdField = field.name === "id" || field.name.endsWith("Id") || field.name.endsWith("_id")
	if (isIdField && !field.length) return mutative ? ".regex(/^\\S{1,48}$/)" : ".min(1).max(48)"
	const min = minOf(annotations, field, schemaType)
	const pattern = annotations.pattern !== null && mutative ? `.regex(${annotations.pattern})` : ""
	const https =
		annotations.url && mutative ? `.refine((v) => /^https:\\/\\//.test(v), { message: "Must be an HTTPS URL" })` : ""
	return min + maxOf(annotations, field) + pattern + https
}

function textBase(build: Build): Built {
	const { annotations, field, imports, schemaType } = build
	if (!/c\.(text|id)[<(]/.test(field.raw)) return undefined
	const typed = field.raw.includes(".$type<") ? typedSchema(field.raw, imports.jsonSchemaImports) : null
	if (typed !== null) return typed
	const mutative = isMutative(schemaType)
	return stringKind(annotations, mutative) + transforms(annotations, mutative) + textBounds(build)
}

function numberBase({ annotations, field }: Build): Built {
	if (/c\.(createdAt|updatedAt|deletedAt|timestamp)[<(]/.test(field.raw)) return "timestampSchema"
	const { max, min } = annotations
	if (/c\.(integer|serialId)[<(]/.test(field.raw)) {
		/* an unbounded integer is a non-negative count up to what a JS number holds exactly */
		const floor = min === null ? ".nonnegative()" : `.min(${min})`
		return `z.number().int()${floor}.max(${max ?? "Number.MAX_SAFE_INTEGER"})`
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
 * it: a private column is never read back, a reference is never updated.
 */
export function generateFieldSchema(field: FieldMeta, schemaType: SchemaType, imports: ImportsMeta): string | null {
	if (field.constraints.private && isRead(schemaType)) return null
	const build: Build = { annotations: field.constraints, field, imports, schemaType }
	for (const builder of BUILDERS) {
		const base = builder(build)
		if (base === null) return null
		if (base !== undefined) return finish(field, schemaType, base)
	}
	return finish(field, schemaType, "z.unknown()")
}
