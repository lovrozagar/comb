/**
 * One table definition: its fields, its options (composite key, unique indexes, CHECKs) and the
 * facts derived from them.
 */
import { type ObjectLiteralExpression, SyntaxKind, type VariableDeclaration } from "ts-morph"
import { parseField } from "./analyze-field.ts"
import type {
	CheckConstraintMeta,
	FieldMeta,
	ImportsMeta,
	TableMeta,
	TimestampsMeta,
	UniqueIndexMeta,
} from "./analyzer-types.ts"
import { getTableName } from "./utils/ts-morph.ts"

/** Detect timestamp fields and style from field list */
function detectTimestamps(fields: FieldMeta[]): TimestampsMeta {
	let createdAt = false
	let updatedAt = false
	let deletedAt = false
	let style: "camelCase" | "snake_case" = "camelCase"

	for (const f of fields) {
		if (f.name === "createdAt" || f.name === "created_at") {
			createdAt = true
			if (f.name === "created_at") style = "snake_case"
		}
		if (f.name === "updatedAt" || f.name === "updated_at") {
			updatedAt = true
			if (f.name === "updated_at") style = "snake_case"
		}
		if (f.name === "deletedAt" || f.name === "deleted_at") {
			deletedAt = true
			if (f.name === "deleted_at") style = "snake_case"
		}
	}

	return { createdAt, deletedAt, style, updatedAt }
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

/** Every field of a table's column object; records the enum and JSON schema imports they use. */
function fieldsOf(columns: ObjectLiteralExpression, imports: ImportsMeta): FieldMeta[] {
	const fields: FieldMeta[] = []
	for (const property of columns.getProperties()) {
		const assignment = property.asKind(SyntaxKind.PropertyAssignment)
		const value = assignment?.getInitializer()
		if (assignment === undefined || value === undefined) continue
		const field = parseField(assignment.getName(), value.getText())
		fields.push(field)
		const enumModule = field.enumName === null ? undefined : imports.identifiers.get(field.enumName)
		if (field.enumName !== null && enumModule !== undefined) imports.enumImports.set(field.enumName, enumModule)
		if (field.jsonSchemaName) imports.jsonSchemaImports.add(field.jsonSchemaName)
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
