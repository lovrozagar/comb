/**
 * Pre-generation validation for Drizzle table definitions.
 *
 * Tiered: hard errors (would produce invalid code) vs warnings (suspicious patterns).
 */
import { SyntaxKind } from "ts-morph"
import { CURSOR_TIEBREAK_COLUMN } from "../../query/cursor.ts"
import {
	createProjectFromTablesDir,
	extractEnumValues,
	extractStates,
	getTableName,
	isTableDefinition,
} from "./ts-morph.ts"

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
			const tenantColumns: string[] = []
			let primaryKeyProperty: string | null = null
			let hasCompositePrimaryKey = false
			const fieldNames = new Set<string>()
			const constraintNames = new Set<string>()
			const stateColumns: string[] = []

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

				/* Declared state machine — a typo silently disables a rule, so the
				   names are checked against the value list rather than trusted. */
				const states = extractStates(raw)
				if (states) {
					stateColumns.push(key)
					const values = extractEnumValues(raw)
					if (values === null) {
						warnings.push(`${varName}.${key}: states declared but the enum values are a reference comb cannot read`)
					} else {
						const known = new Set(values)
						const unknown = (names: string[], where: string) => {
							for (const n of names) {
								if (!known.has(n))
									errors.push(`${varName}.${key}: ${where} names "${n}", which is not a declared value`)
							}
						}
						if (states.initial !== null) unknown([states.initial], "initial")
						if (states.terminal) unknown(states.terminal, "terminal")

						const terminal = new Set(states.terminal ?? [])
						const transitions = states.transitions ?? null
						if (transitions) {
							for (const [from, to] of Object.entries(transitions)) {
								unknown([from], "transitions")
								unknown(to, `transitions.${from}`)
								if (terminal.has(from)) {
									errors.push(`${varName}.${key}: "${from}" is listed as terminal but also has outgoing transitions`)
								}
							}

							/* A map that names every non-terminal is "declared in full".
							   Unreachable states are then almost always a rename that
							   missed a spot. A partial map is how an app declares only
							   the part it knows, so dead-state checking stays off. */
							const nonTerminal = values.filter((v) => !terminal.has(v))
							const declaredFull = nonTerminal.every((v) => Object.hasOwn(transitions, v))
							if (declaredFull) {
								const reachable = new Set<string>()
								if (states.initial !== null) reachable.add(states.initial)
								for (const to of Object.values(transitions)) {
									for (const dest of to) reachable.add(dest)
								}
								for (const state of values) {
									if (!reachable.has(state)) {
										errors.push(`${varName}.${key}: "${state}" is neither initial nor reachable through any transition`)
									}
								}
							}

							for (const [from, to] of Object.entries(transitions)) {
								if (to.length === 0 && !terminal.has(from) && known.has(from)) {
									const report = declaredFull ? errors : warnings
									report.push(`${varName}.${key}: "${from}" has no outgoing transitions and is not terminal`)
								}
							}
						}
					}
				}

				/* Declared tenant scope */
				if (/\btenant\s*:\s*true\b/.test(raw)) {
					tenantColumns.push(key)
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

			/* A table has one tenant boundary or none. Two declarations have no safe
			   resolution — picking either would publish a boundary nobody chose — so
			   the fact is dropped and reported rather than guessed at. */
			if (tenantColumns.length > 1) {
				errors.push(
					`${varName}: ${tenantColumns.length} columns declare { tenant: true } (${tenantColumns.join(", ")}). ` +
						`A table scopes to at most one tenant column.`,
				)
			}

			/* v1 publishes at most one machine per table. A second declaration is
			   real but dropped, so say so rather than letting the extra one vanish. */
			if (stateColumns.length > 1) {
				warnings.push(
					`${varName}: ${stateColumns.length} columns declare a state machine (${stateColumns.join(", ")}). ` +
						`Only the first is published.`,
				)
			}

			/* Keyset pagination resolves its tiebreak column by the property name
			   CURSOR_TIEBREAK_COLUMN, so a primary key declared under any other
			   property cannot be cursor-paginated.

			   A warning, not an error: plenty of tables are never listed — join
			   tables, config tables, lookup maps — and for those the property name
			   is a free choice that codegen has no business blocking. The exact
			   guarantee lives where it can be exact, in buildListQuery, which
			   throws when it is actually asked to page such a table. */
			if (primaryKeyProperty !== null && !hasCompositePrimaryKey && primaryKeyProperty !== CURSOR_TIEBREAK_COLUMN) {
				warnings.push(
					`${varName}: primary key is declared as "${primaryKeyProperty}", so this table cannot be ` +
						`cursor-paginated — buildListQuery resolves its tiebreak by the property name ` +
						`"${CURSOR_TIEBREAK_COLUMN}". Harmless if the table is never listed; otherwise rename the ` +
						`property to "${CURSOR_TIEBREAK_COLUMN}" (the SQL column name is unaffected).`,
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
