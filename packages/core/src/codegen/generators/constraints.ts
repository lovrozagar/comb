/**
 * Constraint map generator — pure transformer from TableMeta[].
 *
 * Generates constraint maps from analyzed table metadata for database error handling.
 */
import path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { toScreamingSnakeCase } from "../utils/case.ts"
import { writeGenFile } from "../utils/fs.ts"

type Constraint = {
	cause: string
	errorKey: string
	statusKey: string
}

type TableConstraints = {
	check?: Record<string, Constraint>
	foreignKey?: Record<string, Constraint>
	primaryKey?: Constraint
	unique?: Record<string, Constraint>
}

type ConstraintMap = Record<string, TableConstraints>

type ConstraintsConfig = {
	output: string
}

/** Generate constraint map from analyzed tables */
export function generateConstraints(tables: TableMeta[], dbName: string, config: ConstraintsConfig, cwd: string): void {
	const outputPath = path.resolve(cwd, config.output)
	const constraintMap: ConstraintMap = {}

	for (const table of tables) {
		const tableName = table.sqlName
		const tableEntry: TableConstraints = {}

		/* Primary key constraints */
		const hasPK = table.fields.some((f) => f.isPrimaryKey) || table.hasCompositePrimaryKey
		if (hasPK) {
			tableEntry.primaryKey = {
				cause: "Record with this ID already exists",
				errorKey: `${tableName}_id_duplicate`,
				statusKey: "conflict",
			}
		}

		/* Foreign key constraints */
		const fkFields = table.fields.filter((f) => f.foreignKey !== null)
		if (fkFields.length > 0) {
			tableEntry.foreignKey = {}
			for (const field of fkFields) {
				tableEntry.foreignKey[field.name] = {
					cause: "Referenced record does not exist",
					errorKey: `${tableName}_${field.name}_reference_not_found`,
					statusKey: "conflict",
				}
			}
		}

		/* Unique constraints from column .unique() */
		const uniqueColumnFields = table.fields.filter((f) => /\.unique\(\)/.test(f.raw))
		if (uniqueColumnFields.length > 0) {
			if (!tableEntry.unique) tableEntry.unique = {}
			for (const field of uniqueColumnFields) {
				tableEntry.unique[field.name] = {
					cause: `A record with this ${field.name} value already exists`,
					errorKey: `${tableName}_${field.name}_duplicate`,
					statusKey: "conflict",
				}
			}
		}

		/* Unique indexes from table options */
		for (const idx of table.uniqueIndexes) {
			if (!tableEntry.unique) tableEntry.unique = {}
			for (const col of idx.columns) {
				tableEntry.unique[col] = {
					cause: `A record with this ${col} value already exists`,
					errorKey: `${tableName}_${col}_duplicate`,
					statusKey: "conflict",
				}
			}
		}

		/* Check constraints from table options */
		for (const chk of table.checkConstraints) {
			if (!tableEntry.check) tableEntry.check = {}

			let cause = "Check constraint violated"
			let statusKey = "conflict"

			if (chk.name.endsWith("_enum")) {
				cause = "Invalid enum value"
				statusKey = "bad_request"
			} else if (chk.name.includes("_size")) {
				const byteLimitMatch = chk.expression.match(/<=\s*(\d+)/)
				if (byteLimitMatch && byteLimitMatch[1] !== undefined) {
					const bytes = Number.parseInt(byteLimitMatch[1], 10)
					const kb = Math.round(bytes / 1024)
					cause = `Exceeds maximum size of ${kb}KB`
					statusKey = "bad_request"
				}
			} else if (chk.name.includes("expiry") || chk.name.includes("valid")) {
				cause = "Invalid date/time constraint"
				statusKey = "bad_request"
			} else if (chk.name.includes("integrity")) {
				cause = "Data integrity constraint violated"
			}

			tableEntry.check[chk.name] = {
				cause,
				errorKey: `${tableName}_${chk.name}_failed`,
				statusKey,
			}
		}

		if (Object.keys(tableEntry).length > 0) {
			constraintMap[tableName] = tableEntry
		}
	}

	/* Generate output */
	const outputContent = generateConstraintMapCode(constraintMap, dbName)
	writeGenFile(outputPath, outputContent, "comb")

	/* Count total constraints */
	let totalConstraints = 0
	for (const table of Object.values(constraintMap)) {
		if (table.primaryKey) totalConstraints++
		if (table.foreignKey) totalConstraints += Object.keys(table.foreignKey).length
		if (table.unique) totalConstraints += Object.keys(table.unique).length
		if (table.check) totalConstraints += Object.keys(table.check).length
	}

	console.log(`Generated constraint map for ${dbName} database at: ${outputPath}`)
	console.log(`Tables: ${Object.keys(constraintMap).length}, Total constraints: ${totalConstraints}`)
}

/** Generate TypeScript constraint map code */
function generateConstraintMapCode(map: ConstraintMap, dbName: string): string {
	const lines: string[] = []
	const constName = `${toScreamingSnakeCase(dbName)}_DB_CONSTRAINT_MAP`

	lines.push(`export const ${constName} = {`)

	const tableNames = Object.keys(map).sort()
	for (let tableIndex = 0; tableIndex < tableNames.length; tableIndex++) {
		const tableName = tableNames[tableIndex]
		if (tableName === undefined) continue
		const tableConstraints = map[tableName]
		if (!tableConstraints) continue

		lines.push(`\t/* ${tableName} table constraints */`)
		lines.push(`\t${tableName}: {`)

		const constraintTypes = Object.keys(tableConstraints).sort()
		for (let typeIndex = 0; typeIndex < constraintTypes.length; typeIndex++) {
			const type = constraintTypes[typeIndex]
			if (type === undefined) continue
			const constraints = tableConstraints[type as keyof TableConstraints]

			if (type === "primaryKey" && constraints && typeof constraints === "object" && "errorKey" in constraints) {
				lines.push("\t\t/* primary key constraint */")
				lines.push("\t\tprimaryKey: {")
				lines.push(`\t\t\terrorKey: "${constraints.errorKey}",`)
				lines.push(`\t\t\tcause: "${constraints.cause}",`)
				lines.push(`\t\t\tstatusKey: "${constraints.statusKey}",`)
				lines.push(`\t\t}${typeIndex < constraintTypes.length - 1 ? "," : ""}`)
			} else if (constraints && typeof constraints === "object") {
				let constraintLabel = "constraints"
				if (type === "foreignKey") {
					constraintLabel = "foreign key constraints"
				} else if (type === "unique") {
					constraintLabel = "unique constraints"
				} else if (type === "check") {
					constraintLabel = "check constraints"
				}

				lines.push(`\t\t/* ${constraintLabel} */`)
				lines.push(`\t\t${type}: {`)

				const columns = Object.keys(constraints).sort()
				for (let colIndex = 0; colIndex < columns.length; colIndex++) {
					const column = columns[colIndex]
					if (column === undefined) continue
					const constraint = (constraints as Record<string, Constraint>)[column]
					if (!constraint) continue
					lines.push(`\t\t\t${column}: {`)
					lines.push(`\t\t\t\terrorKey: "${constraint.errorKey}",`)
					lines.push(`\t\t\t\tcause: "${constraint.cause}",`)
					lines.push(`\t\t\t\tstatusKey: "${constraint.statusKey}",`)
					lines.push(`\t\t\t}${colIndex < columns.length - 1 ? "," : ""}`)
				}

				lines.push(`\t\t}${typeIndex < constraintTypes.length - 1 ? "," : ""}`)
			}
		}

		lines.push(`\t}${tableIndex < tableNames.length - 1 ? "," : ""}`)
	}

	lines.push("} as const")
	lines.push("")

	return lines.join("\n")
}
