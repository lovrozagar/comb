/**
 * Pre-generation validation for Drizzle table definitions.
 *
 * Tiered: hard errors (would produce invalid code) vs warnings (suspicious patterns).
 */
import { SyntaxKind } from "ts-morph"
import { CURSOR_TIEBREAK_COLUMN } from "../../query/cursor.ts"
import { createProjectFromTablesDir, getTableName, isTableDefinition } from "./ts-morph.ts"

type ValidationResult = {
	errors: string[]
	warnings: string[]
}

/**
 * Validate tables file before codegen. Returns errors + warnings.
 * Hard errors should abort generation. Warnings are informational.
 */
export function validateTables(tablesPath: string): ValidationResult {
	const errors: string[] = []
	const warnings: string[] = []

	const project = createProjectFromTablesDir(tablesPath)
	const tableNames = new Set<string>()
	const tableVarNames = new Set<string>()
	const fkTargets: { column: string; refTable: string; sourceTable: string }[] = []

	for (const file of project.getSourceFiles()) {
		for (const stmt of file.getVariableStatements()) {
			const declaration = stmt.getDeclarations()[0]
			if (!declaration || declaration.getKind() !== SyntaxKind.VariableDeclaration) continue

			const initializer = declaration.getInitializer()
			if (!initializer) continue
			const initText = initializer.getText()
			if (!isTableDefinition(initText)) continue

			const varName = declaration.getName()
			const tableName = getTableName(varName, initializer)

			/* Duplicate table name check */
			if (tableNames.has(tableName)) {
				errors.push(`Duplicate SQL table name: "${tableName}" (var: ${varName})`)
			}
			tableNames.add(tableName)

			if (tableVarNames.has(varName)) {
				errors.push(`Duplicate table variable name: "${varName}"`)
			}
			tableVarNames.add(varName)

			const callExpr = initializer.asKind(SyntaxKind.CallExpression)
			if (!callExpr) continue
			const args = callExpr.getArguments()
			if (args.length < 2) continue

			const schemaArg = args[1]
			if (!schemaArg) continue
			const schemaObj = schemaArg.asKind(SyntaxKind.ObjectLiteralExpression)
			if (!schemaObj) continue

			let hasPrimaryKey = false
			let primaryKeyProperty: string | null = null
			let hasCompositePrimaryKey = false
			const fieldNames = new Set<string>()
			const constraintNames = new Set<string>()

			for (const p of schemaObj.getProperties()) {
				const prop = p.asKind(SyntaxKind.PropertyAssignment)
				if (!prop) continue

				const key = prop.getName()
				const value = prop.getInitializer()
				if (!value) continue
				const raw = value.getText()

				/* Duplicate field */
				if (fieldNames.has(key)) {
					errors.push(`${varName}: duplicate field "${key}"`)
				}
				fieldNames.add(key)

				/* Primary key detection */
				if (/\.primaryKey\(/.test(raw) || /c\.id\(/.test(raw)) {
					hasPrimaryKey = true
					primaryKeyProperty = key
				}

				/* FK references */
				const fkMatch = raw.match(/\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/)
				if (fkMatch && fkMatch[1] !== undefined) {
					fkTargets.push({ column: key, refTable: fkMatch[1], sourceTable: varName })
				}
			}

			/* Check composite PK in table options */
			if (args.length >= 3) {
				const optionsArg = args[2]
				if (optionsArg) {
					const bodyText = optionsArg.getText()
					if (/primaryKey\s*\(\s*\{/.test(bodyText)) {
						hasPrimaryKey = true
						hasCompositePrimaryKey = true
					}

					/* Detect duplicate constraint names in options */
					const constraintPattern = /(?:uniqueIndex|check)\s*\(\s*["']([^"']+)["']/g
					let match = constraintPattern.exec(bodyText)
					while (match !== null) {
						const name = match[1]
						if (name !== undefined) {
							if (constraintNames.has(name)) {
								warnings.push(`${varName}: duplicate constraint name "${name}"`)
							}
							constraintNames.add(name)
						}
						match = constraintPattern.exec(bodyText)
					}
				}
			}

			if (!hasPrimaryKey) {
				warnings.push(`${varName}: no primary key detected`)
			}

			/* Keyset pagination resolves its tiebreak column by the property name
			   CURSOR_TIEBREAK_COLUMN. When the primary key sits under a different
			   property, buildCursorWhere finds nothing and returns null — which is
			   not an error, it just omits the cursor predicate, so the same page is
			   returned again and rows silently duplicate and skip. Reject the shape
			   rather than let it fail quietly at runtime. */
			if (primaryKeyProperty !== null && !hasCompositePrimaryKey && primaryKeyProperty !== CURSOR_TIEBREAK_COLUMN) {
				errors.push(
					`${varName}: primary key is declared as "${primaryKeyProperty}" but cursor pagination ` +
						`resolves its tiebreak by the property name "${CURSOR_TIEBREAK_COLUMN}". ` +
						`Rename the property to "${CURSOR_TIEBREAK_COLUMN}" (the SQL column name is unaffected).`,
				)
			}
		}
	}

	/* Validate FK targets reference existing tables */
	for (const fk of fkTargets) {
		if (!tableVarNames.has(fk.refTable)) {
			errors.push(`${fk.sourceTable}.${fk.column}: FK references "${fk.refTable}" which is not defined in tables file`)
		}
	}

	return { errors, warnings }
}
