/**
 * One table definition: its fields, its options (composite key, unique indexes, CHECKs) and the
 * facts derived from them.
 */
import { type Node, type ObjectLiteralExpression, SyntaxKind, type VariableDeclaration } from "ts-morph"
import { parseField } from "./analyze-field.ts"
import { readTableOptions } from "./analyze-options.ts"
import type { FieldMeta, ImportsMeta, TableMeta, TimestampsMeta } from "./analyzer-types.ts"
import { readEnum, resolve } from "./utils/enum-source.ts"
import { textWithoutComments } from "./utils/node-text.ts"
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
	/* a comment in the chain is a note, not code: `// TODO: .notNull()` declares nothing */
	const raw = textWithoutComments(value)
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

/** A property's name as written: `"display-name"` is display-name. */
function keyOf(name: Node): string {
	return name.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? name.getText()
}

/** Every field of a table's column object, through spreads of shared column consts; records the names they import. */
function fieldsOf(columns: ObjectLiteralExpression, imports: ImportsMeta, depth = 0): FieldMeta[] {
	const fields: FieldMeta[] = []
	for (const property of columns.getProperties()) {
		const spread = property.asKind(SyntaxKind.SpreadAssignment)
		const shared = resolve(spread?.getExpression())?.asKind(SyntaxKind.ObjectLiteralExpression)
		if (shared !== undefined && depth < 4) fields.push(...fieldsOf(shared, imports, depth + 1))
		const assignment = property.asKind(SyntaxKind.PropertyAssignment)
		const value = assignment?.getInitializer()
		if (assignment !== undefined && value !== undefined)
			fields.push(fieldOf(keyOf(assignment.getNameNode()), value, imports))
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
		...readTableOptions(args[2]),
		fields,
		idPrefix,
		sqlName: getTableName(varName, initializer),
		timestamps: detectTimestamps(fields),
		varName,
	}
}
