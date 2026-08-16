/**
 * Enum CHECK constraint generator — produces per-table check functions
 * that enforce enum values at the database level.
 *
 * Generated output:
 * ```ts
 * import { check } from "drizzle-orm/sqlite-core"
 * import { sql } from "drizzle-orm"
 *
 * export function userEnumChecks(table: Record<string, unknown>) {
 *   return [
 *     check("user_role_enum", sql`${table.role} IN ('admin', 'user', 'guest')`),
 *   ]
 * }
 * ```
 */
import path from "node:path"
import type { TableMeta } from "../analyzer-types.ts"
import { writeGenFile } from "../utils/fs.ts"

type EnumChecksConfig = {
	output: string
}

type EnumField = {
	fieldName: string
	values: string[]
}

function getEnumFields(table: TableMeta): EnumField[] {
	const result: EnumField[] = []

	for (const field of table.fields) {
		if (field.enumValues && field.enumValues.length > 0) {
			result.push({
				fieldName: field.name,
				values: field.enumValues,
			})
		}
	}

	return result
}

function toCamelCase(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function escapeValue(val: string): string {
	return val.replace(/'/g, "''")
}

export function generateEnumChecks(tables: TableMeta[], dbName: string, config: EnumChecksConfig, cwd: string): void {
	const outputPath = path.resolve(cwd, config.output)

	const tablesWithEnums: Array<{ enumFields: EnumField[]; table: TableMeta }> = []

	for (const table of tables) {
		const enumFields = getEnumFields(table)
		if (enumFields.length > 0) {
			tablesWithEnums.push({ enumFields, table })
		}
	}

	if (tablesWithEnums.length === 0) {
		console.log(`No enum fields found in ${dbName} — skipping enum-checks generation`)
		return
	}

	const lines: string[] = []
	lines.push(`import { check } from "drizzle-orm/sqlite-core"`)
	lines.push(`import { sql } from "drizzle-orm"`)
	lines.push("")

	for (const { enumFields, table } of tablesWithEnums) {
		const fnName = `${toCamelCase(table.varName)}EnumChecks`
		lines.push(`export function ${fnName}(table: Record<string, unknown>) {`)
		lines.push("\treturn [")

		for (const ef of enumFields) {
			const inList = ef.values.map((v) => `'${escapeValue(v)}'`).join(", ")
			const checkName = `${table.sqlName}_${ef.fieldName}_enum`
			lines.push(`\t\tcheck("${checkName}", sql\`\${table.${ef.fieldName}} IN (${inList})\`),`)
		}

		lines.push("\t]")
		lines.push("}")
		lines.push("")
	}

	writeGenFile(outputPath, lines.join("\n"), "comb")

	let totalEnums = 0
	for (const { enumFields } of tablesWithEnums) {
		totalEnums += enumFields.length
	}

	console.log(`Generated enum checks for ${dbName} at: ${outputPath}`)
	console.log(`Tables: ${tablesWithEnums.length}, Enum columns: ${totalEnums}`)
}
