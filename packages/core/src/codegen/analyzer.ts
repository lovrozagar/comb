/**
 * TableAnalyzer — single-pass ts-morph AST traversal.
 *
 * Produces TableMeta[] consumed by all generators as pure transformers.
 * Centralizes all AST parsing so generators never touch ts-morph.
 */
import { SyntaxKind } from "ts-morph"
import type {
	AnalysisResult,
	CheckConstraintMeta,
	FieldMeta,
	ForeignKeyRef,
	ImportsMeta,
	TableMeta,
	TimestampsMeta,
	UniqueIndexMeta,
} from "./analyzer-types.ts"
import { parseFieldConstraints } from "./annotations.ts"
import {
	buildIdentifierValueMap,
	createProjectFromTablesDir,
	extractDbName,
	extractEnumFromType,
	extractEnumValues,
	extractLength,
	extractStates,
	getTableName,
	getTablesImportPath,
	isTableDefinition,
	setIdentifierValueMap,
} from "./utils/ts-morph.ts"

/**
 * Extract Drizzle helper name from raw initializer text.
 * e.g. "c.text(...)" -> "text", "c.createdAt(...)" -> "createdAt"
 */
function extractDrizzleHelper(raw: string): string {
	const match = raw.match(/c\.(\w+)[<(]/)
	return match?.[1] ?? "unknown"
}

/**
 * Extract JSON schema name from c.json("columnName", schemaName) call
 */
function extractJsonSchemaFromCall(raw: string): string | null {
	const match = raw.match(/c\.json(?:<[^>]+>)?\("[\w_]+",\s*(\w+)(?:,\s*\{[^}]*\})?\)/)
	return match?.[1] ?? null
}

/**
 * Extract FK reference info from .references(() => table.column, { onDelete: "cascade" })
 */
function extractForeignKey(raw: string, fieldName: string): ForeignKeyRef | null {
	const refMatch = raw.match(/\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)(?:,\s*\{([^}]*)\})?\)/)
	if (!refMatch || refMatch[1] === undefined || refMatch[2] === undefined) return null

	const optionsStr = refMatch[3] ?? ""
	/* Drizzle's referential actions include multi-word forms — "set null",
	   "set default", "no action" — so \w+ would silently drop three of five. */
	const onDeleteMatch = optionsStr.match(/onDelete:\s*["']([^"']+)["']/)
	const onUpdateMatch = optionsStr.match(/onUpdate:\s*["']([^"']+)["']/)

	return {
		column: fieldName,
		onDelete: onDeleteMatch?.[1],
		onUpdate: onUpdateMatch?.[1],
		refColumn: refMatch[2],
		refTable: refMatch[1],
	}
}

/** Parse a single field from a property assignment node. */
function parseField(key: string, raw: string): FieldMeta {
	const constraints = parseFieldConstraints(raw, key)
	const isPrimaryKey = /\.primaryKey\(/.test(raw) || /c\.id\(/.test(raw)
	const isNotNull = /\.notNull\(\)/.test(raw) || isPrimaryKey
	const drizzleHelper = extractDrizzleHelper(raw)
	const enumName = extractEnumFromType(raw)
	const enumValues = extractEnumValues(raw)
	const states = extractStates(raw)
	const jsonSchemaName = extractJsonSchemaFromCall(raw)
	const foreignKey = extractForeignKey(raw, key)
	const length = extractLength(raw)

	/* Also detect FK from c.ref helper */
	let fk = foreignKey
	if (!fk && /c\.ref[<(]/.test(raw)) {
		const refHelperMatch = raw.match(/c\.ref[<(].*?\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/)
		if (refHelperMatch && refHelperMatch[1] !== undefined && refHelperMatch[2] !== undefined) {
			fk = {
				column: key,
				refColumn: refHelperMatch[2],
				refTable: refHelperMatch[1],
			}
		}
	}

	return {
		constraints,
		drizzleHelper,
		enumName,
		enumValues,
		states,
		foreignKey: fk,
		isNotNull,
		isPrimaryKey,
		jsonSchemaName,
		length,
		name: key,
		raw,
	}
}

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

/**
 * Analyze a tables file and produce the full AnalysisResult.
 * Single-pass ts-morph traversal — all generators consume this output.
 */
function analyze(tablesPath: string, cwd?: string): AnalysisResult {
	const project = createProjectFromTablesDir(tablesPath)

	const imports: ImportsMeta = {
		enumImports: new Map(),
		identifiers: new Map(),
		jsonSchemaImports: new Set(),
	}

	const tables: TableMeta[] = []

	/* Pre-scan: collect all imports across source files */
	for (const file of project.getSourceFiles()) {
		for (const importDecl of file.getImportDeclarations()) {
			const moduleSpecifier = importDecl.getModuleSpecifierValue()
			for (const namedImport of importDecl.getNamedImports()) {
				imports.identifiers.set(namedImport.getName(), moduleSpecifier)
			}
		}
	}

	/* Resolve imported identifier values for constraint pattern resolution */
	if (cwd) {
		setIdentifierValueMap(buildIdentifierValueMap(imports.identifiers, cwd))
	}

	/* Main pass: extract all table metadata */
	for (const file of project.getSourceFiles()) {
		for (const stmt of file.getVariableStatements()) {
			const declaration = stmt.getDeclarations()[0]
			if (!declaration || declaration.getKind() !== SyntaxKind.VariableDeclaration) continue

			const initializer = declaration.getInitializer()
			if (!initializer) continue
			const initText = initializer.getText()
			if (!isTableDefinition(initText)) continue

			const varName = declaration.getName()
			const sqlName = getTableName(varName, initializer)

			const callExpr = initializer.asKind(SyntaxKind.CallExpression)
			if (!callExpr) continue
			const args = callExpr.getArguments()
			if (args.length < 2) continue

			const schemaArg = args[1]
			if (!schemaArg) continue
			const schemaObj = schemaArg.asKind(SyntaxKind.ObjectLiteralExpression)
			if (!schemaObj) continue

			/* Parse all fields */
			const fields: FieldMeta[] = []
			for (const p of schemaObj.getProperties()) {
				const prop = p.asKind(SyntaxKind.PropertyAssignment)
				if (!prop) continue

				const key = prop.getName()
				const value = prop.getInitializer()
				if (!value) continue

				const raw = value.getText()
				const field = parseField(key, raw)
				fields.push(field)

				/* Track enum and JSON schema imports */
				if (field.enumName && imports.identifiers.has(field.enumName)) {
					imports.enumImports.set(field.enumName, imports.identifiers.get(field.enumName) ?? "")
				}
				if (field.jsonSchemaName) {
					imports.jsonSchemaImports.add(field.jsonSchemaName)
				}
			}

			/* Parse table options (3rd argument) */
			let hasCompositePrimaryKey = false
			let uniqueIndexes: UniqueIndexMeta[] = []
			let checkConstraints: CheckConstraintMeta[] = []

			if (args.length >= 3) {
				const optionsArg = args[2]
				if (optionsArg) {
					const arrow = optionsArg.asKind(SyntaxKind.ArrowFunction)
					if (arrow) {
						const bodyText = arrow.getBody().getText()
						const paramName = arrow.getParameters()[0]?.getName() ?? "t"
						const parsed = parseTableOptions(bodyText, paramName)
						hasCompositePrimaryKey = parsed.hasCompositePrimaryKey
						uniqueIndexes = parsed.uniqueIndexes
						checkConstraints = parsed.checkConstraints
					}
				}
			}

			/* Extract entity ID prefix from c.id("prefix") */
			const idField = fields.find((f) => /c\.id\(/.test(f.raw))
			const idPrefixMatch = idField?.raw.match(/c\.id\(["'](\w+)["']\)/)
			const idPrefix = idPrefixMatch?.[1] ?? null

			tables.push({
				checkConstraints,
				fields,
				hasCompositePrimaryKey,
				idPrefix,
				sqlName,
				timestamps: detectTimestamps(fields),
				uniqueIndexes,
				varName,
			})
		}
	}

	tables.sort((a, b) => a.varName.localeCompare(b.varName))

	return {
		dbName: extractDbName(tablesPath),
		imports,
		tables,
		tablesImportPath: getTablesImportPath(tablesPath),
	}
}

export { analyze }
export type { AnalysisResult, TableMeta }
