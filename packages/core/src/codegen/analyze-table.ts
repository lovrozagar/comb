/**
 * One table definition: its fields, its options (composite key, unique indexes, CHECKs) and the
 * facts derived from them.
 */
import { type Node, type ObjectLiteralExpression, SyntaxKind, type VariableDeclaration } from "ts-morph"
import { parseField } from "./analyze-field.ts"
import type {
	CheckConstraintMeta,
	FieldMeta,
	ImportsMeta,
	TableMeta,
	TimestampsMeta,
	UniqueIndexMeta,
} from "./analyzer-types.ts"
import { readEnum } from "./utils/enum-source.ts"
import { type ImportRef, importRefs, type JsonSchemaSource, readJsonSchema } from "./utils/schema-source.ts"
import { getTableName } from "./utils/ts-morph.ts"

/** The timestamp columns a table has, and their casing */
// lookup-table: timestamp column names under either casing
const TIMESTAMP_KEYS: Record<string, keyof Omit<TimestampsMeta, "style">> = {
	createdAt: "createdAt",
	created_at: "createdAt",
	deletedAt: "deletedAt",
	deleted_at: "deletedAt",
	updatedAt: "updatedAt",
	updated_at: "updatedAt",
}

/* the shared timestamp schemas are epoch milliseconds; a text or JSON column under the name is not one */
const EPOCH_HELPERS = /^\s*(?:c\.(?:createdAt|updatedAt|deletedAt|timestamp|integer)|integer)\s*\(/

function detectTimestamps(fields: FieldMeta[]): TimestampsMeta {
	const found: TimestampsMeta = { createdAt: false, deletedAt: false, style: "camelCase", updatedAt: false }
	for (const field of fields) {
		const key = Object.hasOwn(TIMESTAMP_KEYS, field.name) ? TIMESTAMP_KEYS[field.name] : undefined
		if (key === undefined || !EPOCH_HELPERS.test(field.raw)) continue
		found[key] = true
		if (field.name.includes("_")) found.style = "snake_case"
	}
	return found
}

/**
 * Parse table options (3rd arg arrow function) for composite PK, unique indexes, check constraints
 */
function parseTableOptions(
	optionsText: string,
	paramName: string,
): {
	checkConstraints: CheckConstraintMeta[]
	hasCompositePrimaryKey: boolean
	uniqueIndexes: UniqueIndexMeta[]
} {
	const hasCompositePrimaryKey = /primaryKey\s*\(\s*\{/.test(optionsText)
	const uniqueIndexes: UniqueIndexMeta[] = []
	const checkConstraints: CheckConstraintMeta[] = []

	/* Extract uniqueIndex calls: uniqueIndex("name").on(t.col1, t.col2) */
	const uniquePattern = /uniqueIndex\s*\(\s*["']([^"']+)["']\s*\)[\s\S]*?\.on\s*\(([^)]+)\)/g
	for (const match of optionsText.matchAll(uniquePattern)) {
		const name = match[1]
		const onClause = match[2]
		if (name === undefined || onClause === undefined) continue

		const columnPattern = new RegExp(`${paramName}\\.(\\w+)`, "g")
		const columns = [...onClause.matchAll(columnPattern)].map((m) => m[1]).filter((c): c is string => c !== undefined)

		if (columns.length > 0) {
			uniqueIndexes.push({ columns, name })
		}
	}

	/* Extract check constraints: check("name", sql`expr`) */
	const checkPattern = /check\s*\(\s*["']([^"']+)["']\s*,\s*sql`([^`]+)`\s*[,)]/gs
	for (const match of optionsText.matchAll(checkPattern)) {
		const name = match[1]
		const expression = match[2]
		if (name !== undefined && expression !== undefined) {
			checkConstraints.push({ expression: expression.replace(/\s+/g, " ").trim(), name })
		}
	}

	return { checkConstraints, hasCompositePrimaryKey, uniqueIndexes }
}

type TableOptions = ReturnType<typeof parseTableOptions>

const NO_OPTIONS: TableOptions = { checkConstraints: [], hasCompositePrimaryKey: false, uniqueIndexes: [] }

/** The options a table's third argument, `(t) => [...]`, declares. */
function optionsOf(arg: import("ts-morph").Node | undefined): TableOptions {
	const arrow = arg?.asKind(SyntaxKind.ArrowFunction)
	if (arrow === undefined) return NO_OPTIONS
	return parseTableOptions(arrow.getBody().getText(), arrow.getParameters()[0]?.getName() ?? "t")
}

/* `.$type<z.infer<typeof schema>>()` types a column by a schema the DTO validates with */
const INFERRED = /\.\$type<\s*z\.infer<\s*typeof\s+(\w+)\s*>\s*>/

/** The names a field's generated schema uses: an unreadable enum const, a JSON schema's free names, an inferred type's schema. */
function importedNames(enumReference: string | null, json: JsonSchemaSource | null, raw: string): string[] {
	const names = [enumReference, ...(json === null ? [] : json.names), INFERRED.exec(raw)?.[1]]
	return [...new Set(names.filter((name) => typeof name === "string"))]
}

/* the shared-schema pass must not hoist anything that names an import */
function recordImports(refs: ImportRef[], enumReference: string | null, imports: ImportsMeta): void {
	for (const ref of refs) {
		if (ref.name === enumReference) imports.enumImports.set(ref.name, ref.from)
		else imports.jsonSchemaImports.add(ref.name)
	}
}

/** One field, with what only the AST knows: enum values and states, schema and imports. */
function fieldOf(key: string, value: Node, imports: ImportsMeta): FieldMeta {
	const raw = value.getText()
	const enumSource = readEnum(value)
	const enumReference = enumSource === null ? null : enumSource.reference
	const json = readJsonSchema(value)
	const schemaImports = importRefs(importedNames(enumReference, json, raw), value.getSourceFile())
	recordImports(schemaImports, enumReference, imports)
	return {
		...parseField(key, raw, imports.identifierValues),
		enumName: enumReference,
		enumValues: enumSource?.values ?? null,
		jsonSchemaName: json?.expression ?? null,
		schemaImports,
		states: enumSource?.machine ?? null,
	}
}

/** Every field of a table's column object; records the enum and schema names they import. */
function fieldsOf(columns: ObjectLiteralExpression, imports: ImportsMeta): FieldMeta[] {
	const fields: FieldMeta[] = []
	for (const property of columns.getProperties()) {
		const assignment = property.asKind(SyntaxKind.PropertyAssignment)
		const value = assignment?.getInitializer()
		if (assignment !== undefined && value !== undefined) fields.push(fieldOf(assignment.getName(), value, imports))
	}
	return fields
}

/** The table `declaration` defines, or null when its call does not carry a column object. */
export function parseTable(declaration: VariableDeclaration, imports: ImportsMeta): TableMeta | null {
	const initializer = declaration.getInitializer()
	const args = initializer?.asKind(SyntaxKind.CallExpression)?.getArguments() ?? []
	const columns = args[1]?.asKind(SyntaxKind.ObjectLiteralExpression)
	if (initializer === undefined || columns === undefined) return null
	const varName = declaration.getName()
	const fields = fieldsOf(columns, imports)
	const idPrefix = fields.map((f) => /c\.id\(["'](\w+)["']\)/.exec(f.raw)?.[1]).find((p) => p !== undefined) ?? null
	return {
		...optionsOf(args[2]),
		fields,
		idPrefix,
		sqlName: getTableName(varName, initializer),
		timestamps: detectTimestamps(fields),
		varName,
	}
}
